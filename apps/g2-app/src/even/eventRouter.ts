/**
 * Normalizes and routes EvenHub events from the bridge.
 *
 * Wire quirks handled here so the rest of the app never sees them:
 *   - Protobuf omits zero-value fields, and CLICK_EVENT has ordinal 0: a click
 *     arrives as a sysEvent/textEvent whose eventType is `undefined`. Event
 *     types are therefore coalesced to CLICK_EVENT whenever the envelope is
 *     present, before any comparison.
 *   - Taps, double-taps and lifecycle events arrive under `event.sysEvent`;
 *     scroll gestures (and clicks on event-capturing text containers) arrive
 *     under `event.textEvent`. Both envelopes are routed explicitly.
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
  const text = event.textEvent;
  // Coalesce BEFORE comparing: an omitted eventType inside a present envelope
  // means CLICK_EVENT (protobuf zero-value omission).
  const sysType = sys ? (sys.eventType ?? OsEventTypeList.CLICK_EVENT) : null;
  const textType = text ? (text.eventType ?? OsEventTypeList.CLICK_EVENT) : null;

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    handlers.onDoubleClick();
    return;
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
    handlers.onSystemExit('system');
    return;
  }
  if (sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    handlers.onSystemExit('abnormal');
    return;
  }

  if (
    sysType === OsEventTypeList.SCROLL_TOP_EVENT ||
    textType === OsEventTypeList.SCROLL_TOP_EVENT
  ) {
    handlers.onSwipeUp();
    return;
  }
  if (
    sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
    textType === OsEventTypeList.SCROLL_BOTTOM_EVENT
  ) {
    handlers.onSwipeDown();
    return;
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
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
