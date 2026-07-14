import { describe, expect, it, vi } from 'vitest';
import {
  EventSourceType,
  OsEventTypeList,
  Sys_ItemEvent,
  Text_ItemEvent,
} from '@evenrealities/even_hub_sdk';
import type { EventHandlers } from '../src/even/eventRouter';
import {
  acceptAnyClickPolicy,
  classifyEventSource,
  ringOnlyPolicy,
  routeEvenHubEvent,
} from '../src/even/eventRouter';

function makeHandlers(): EventHandlers {
  return {
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    onSwipeUp: vi.fn(),
    onSwipeDown: vi.fn(),
    onSystemExit: vi.fn(),
    onAudioFrame: vi.fn(),
  };
}

describe('routeEvenHubEvent', () => {
  it('treats a sysEvent with omitted eventType as CLICK_EVENT (protobuf zero-value)', () => {
    const handlers = makeHandlers();
    // On the wire, CLICK_EVENT (ordinal 0) is omitted → eventType undefined.
    routeEvenHubEvent({ sysEvent: new Sys_ItemEvent({}) }, handlers, acceptAnyClickPolicy);
    expect(handlers.onClick).toHaveBeenCalledTimes(1);
    expect(handlers.onClick).toHaveBeenCalledWith('unknown');
  });

  it('routes explicit clicks with their classified source', () => {
    const handlers = makeHandlers();
    routeEvenHubEvent(
      {
        sysEvent: new Sys_ItemEvent({
          eventType: OsEventTypeList.CLICK_EVENT,
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
        }),
      },
      handlers,
      acceptAnyClickPolicy,
    );
    expect(handlers.onClick).toHaveBeenCalledWith('ring');
  });

  it('routes double-clicks from either envelope', () => {
    const handlers = makeHandlers();
    routeEvenHubEvent(
      { sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }) },
      handlers,
      acceptAnyClickPolicy,
    );
    routeEvenHubEvent(
      { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }) },
      handlers,
      acceptAnyClickPolicy,
    );
    expect(handlers.onDoubleClick).toHaveBeenCalledTimes(2);
    expect(handlers.onClick).not.toHaveBeenCalled();
  });

  it('routes scroll gestures through the textEvent envelope', () => {
    const handlers = makeHandlers();
    routeEvenHubEvent(
      { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.SCROLL_TOP_EVENT }) },
      handlers,
      acceptAnyClickPolicy,
    );
    routeEvenHubEvent(
      { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT }) },
      handlers,
      acceptAnyClickPolicy,
    );
    expect(handlers.onSwipeUp).toHaveBeenCalledTimes(1);
    expect(handlers.onSwipeDown).toHaveBeenCalledTimes(1);
  });

  it('routes system and abnormal exits', () => {
    const handlers = makeHandlers();
    routeEvenHubEvent(
      { sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.SYSTEM_EXIT_EVENT }) },
      handlers,
      acceptAnyClickPolicy,
    );
    expect(handlers.onSystemExit).toHaveBeenCalledWith('system');
    routeEvenHubEvent(
      { sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.ABNORMAL_EXIT_EVENT }) },
      handlers,
      acceptAnyClickPolicy,
    );
    expect(handlers.onSystemExit).toHaveBeenCalledWith('abnormal');
  });

  it('delivers audio frames alongside other envelopes', () => {
    const handlers = makeHandlers();
    const pcm = new Uint8Array([1, 2, 3]);
    routeEvenHubEvent(
      {
        audioEvent: { audioPcm: pcm, source: 'glasses' } as never,
      },
      handlers,
      acceptAnyClickPolicy,
    );
    expect(handlers.onAudioFrame).toHaveBeenCalledWith(pcm);
  });

  it('ignores empty events', () => {
    const handlers = makeHandlers();
    routeEvenHubEvent({}, handlers, acceptAnyClickPolicy);
    expect(handlers.onClick).not.toHaveBeenCalled();
    expect(handlers.onAudioFrame).not.toHaveBeenCalled();
  });
});

describe('InputSourcePolicy', () => {
  it('classifies every documented EventSourceType', () => {
    expect(
      classifyEventSource(
        new Sys_ItemEvent({ eventSource: EventSourceType.TOUCH_EVENT_FROM_RING }),
      ),
    ).toBe('ring');
    expect(
      classifyEventSource(
        new Sys_ItemEvent({ eventSource: EventSourceType.TOUCH_EVENT_FROM_GLASSES_R }),
      ),
    ).toBe('glasses-right');
    expect(
      classifyEventSource(
        new Sys_ItemEvent({ eventSource: EventSourceType.TOUCH_EVENT_FROM_GLASSES_L }),
      ),
    ).toBe('glasses-left');
    expect(classifyEventSource(new Sys_ItemEvent({}))).toBe('unknown');
    expect(classifyEventSource(undefined)).toBe('unknown');
  });

  it('ringOnlyPolicy drops clicks that are not attributable to the ring', () => {
    const handlers = makeHandlers();
    routeEvenHubEvent({ sysEvent: new Sys_ItemEvent({}) }, handlers, ringOnlyPolicy);
    expect(handlers.onClick).not.toHaveBeenCalled();

    routeEvenHubEvent(
      {
        sysEvent: new Sys_ItemEvent({
          eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
        }),
      },
      handlers,
      ringOnlyPolicy,
    );
    expect(handlers.onClick).toHaveBeenCalledWith('ring');
  });
});
