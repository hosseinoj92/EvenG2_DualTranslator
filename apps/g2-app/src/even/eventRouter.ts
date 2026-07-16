/**
 * Normalizes and routes EvenHub events from the bridge.
 *
 * Wire quirks handled here so the rest of the app never sees them:
 *   - Protobuf omits zero-value fields, and CLICK_EVENT has ordinal 0: a click
 *     arrives as an envelope whose eventType is `undefined`. Event types are
 *     therefore coalesced to CLICK_EVENT whenever the envelope is present,
 *     before any comparison.
 *   - Input events arrive under any of THREE envelopes depending on firmware
 *     and input device: R1 ring taps and lifecycle events under
 *     `event.sysEvent`, scroll gestures and clicks on event-capturing text
 *     containers under `event.textEvent`, and glasses-touchpad taps under
 *     `event.listEvent` on some host versions. All three are routed
 *     identically so the touchpad works exactly like the ring.
 *   - Audio PCM frames arrive under `event.audioEvent`, a separate branch.
 */

import type { EvenHubEvent, Sys_ItemEvent } from '@evenrealities/even_hub_sdk';
import { EventSourceType, OsEventTypeList } from '@evenrealities/even_hub_sdk';
import type { EvenBridge } from './bridge';

export type ClickSource = 'ring' | 'glasses-right' | 'glasses-left' | 'unknown';

/**
 * Decides which physical inputs may drive the app. The SDK exposes
 * `sysEvent.eventSource` (EventSourceType) which distinguishes the R1 ring
 * (TOUCH_EVENT_FROM_RING) from the glasses touchpads — but its zero value
 * (TOUCH_EVENT_FORM_DUMMY_NULL) is omitted on the wire exactly like
 * CLICK_EVENT, so "no metadata" and "dummy source" are indistinguishable, and
 * older firmware may omit the field entirely.
 */
export interface InputSourcePolicy {
  classify(sysEvent: Sys_ItemEvent | undefined): ClickSource;
  acceptClick(source: ClickSource): boolean;
}

export function classifyEventSource(sysEvent: Sys_ItemEvent | undefined): ClickSource {
  switch (sysEvent?.eventSource) {
    case EventSourceType.TOUCH_EVENT_FROM_RING:
      return 'ring';
    case EventSourceType.TOUCH_EVENT_FROM_GLASSES_R:
      return 'glasses-right';
    case EventSourceType.TOUCH_EVENT_FROM_GLASSES_L:
      return 'glasses-left';
    default:
      // Omitted or TOUCH_EVENT_FORM_DUMMY_NULL (0, stripped by protobuf).
      return 'unknown';
  }
}

/**
 * Default policy: every CLICK_EVENT is accepted regardless of source.
 * Because an R1 click without source metadata is indistinguishable from a
 * touchpad click, restricting to `source === 'ring'` would silently drop
 * legitimate ring clicks on firmware that omits eventSource. The classified
 * source is still surfaced for diagnostics.
 */
export const acceptAnyClickPolicy: InputSourcePolicy = {
  classify: classifyEventSource,
  acceptClick: () => true,
};

/** Strict variant, usable once target firmware reliably reports eventSource. */
export const ringOnlyPolicy: InputSourcePolicy = {
  classify: classifyEventSource,
  acceptClick: (source) => source === 'ring',
};

export interface EventHandlers {
  onClick(source: ClickSource): void;
  onDoubleClick(): void;
  onSwipeUp(): void;
  onSwipeDown(): void;
  onSystemExit(reason: 'system' | 'abnormal'): void;
  onAudioFrame(pcm: Uint8Array): void;
}

/** Pure event-classification core, exported for unit tests. */
export function routeEvenHubEvent(
  event: EvenHubEvent,
  handlers: EventHandlers,
  policy: InputSourcePolicy,
): void {
  const pcm = event.audioEvent?.audioPcm;
  if (pcm && pcm.length > 0) {
    handlers.onAudioFrame(pcm);
  }

  const sys = event.sysEvent;
  // Coalesce BEFORE comparing: an omitted eventType inside a present envelope
  // means CLICK_EVENT (protobuf zero-value omission). sysEvent, textEvent and
  // listEvent all carry input gestures; which one a tap arrives under depends
  // on the input device and host version, so they are treated uniformly.
  const types = [event.sysEvent, event.textEvent, event.listEvent]
    .filter((envelope) => envelope !== undefined)
    .map((envelope) => envelope.eventType ?? OsEventTypeList.CLICK_EVENT);
  const has = (type: OsEventTypeList): boolean => types.includes(type);

  if (has(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    handlers.onDoubleClick();
    return;
  }

  if (sys) {
    const sysType = sys.eventType ?? OsEventTypeList.CLICK_EVENT;
    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
      handlers.onSystemExit('system');
      return;
    }
    if (sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      handlers.onSystemExit('abnormal');
      return;
    }
  }

  if (has(OsEventTypeList.SCROLL_TOP_EVENT)) {
    handlers.onSwipeUp();
    return;
  }
  if (has(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
    handlers.onSwipeDown();
    return;
  }

  if (has(OsEventTypeList.CLICK_EVENT)) {
    const source = policy.classify(sys);
    if (policy.acceptClick(source)) {
      handlers.onClick(source);
    }
  }
}

/** Subscribes to the bridge. Returns the unsubscribe function. */
export function subscribeToEvenHubEvents(
  bridge: EvenBridge,
  handlers: EventHandlers,
  policy: InputSourcePolicy = acceptAnyClickPolicy,
): () => void {
  return bridge.onEvenHubEvent((event) => routeEvenHubEvent(event, handlers, policy));
}
