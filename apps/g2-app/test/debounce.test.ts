import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leadingDebounce, trailingDebounce } from '../src/utils/debounce';

describe('leadingDebounce (R1 toggle)', () => {
  it('fires immediately, then swallows clicks inside the window', () => {
    let clock = 0;
    const fn = vi.fn();
    const toggle = leadingDebounce(fn, 400, () => clock);

    toggle();
    expect(fn).toHaveBeenCalledTimes(1);

    clock = 150;
    toggle(); // jittery double click — swallowed
    clock = 399;
    toggle();
    expect(fn).toHaveBeenCalledTimes(1);

    clock = 400;
    toggle(); // window elapsed — accepted
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel() re-arms the leading edge', () => {
    let clock = 0;
    const fn = vi.fn();
    const toggle = leadingDebounce(fn, 400, () => clock);
    toggle();
    toggle.cancel();
    clock = 10;
    toggle();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('trailingDebounce (display writes)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces bursts into the final call', () => {
    const fn = vi.fn();
    const render = trailingDebounce(fn, 120);
    render('a');
    render('b');
    render('c');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('cancel() drops the pending call', () => {
    const fn = vi.fn();
    const render = trailingDebounce(fn, 120);
    render('a');
    render.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});
