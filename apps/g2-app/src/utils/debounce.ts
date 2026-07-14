/**
 * Leading-edge debounce: the first call fires immediately, subsequent calls
 * inside the window are dropped. Used for the R1 direction toggle so a jittery
 * tap cannot flip the direction twice.
 */
export interface LeadingDebounced<Args extends unknown[]> {
  (...args: Args): void;
  cancel(): void;
}

export function leadingDebounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
  now: () => number = Date.now,
): LeadingDebounced<Args> {
  let lastFiredAt = Number.NEGATIVE_INFINITY;

  const debounced = (...args: Args): void => {
    const at = now();
    if (at - lastFiredAt < waitMs) {
      return;
    }
    lastFiredAt = at;
    fn(...args);
  };

  debounced.cancel = () => {
    lastFiredAt = Number.NEGATIVE_INFINITY;
  };

  return debounced;
}

/**
 * Trailing-edge debounce returning a handle with cancel(); used to coalesce
 * display writes.
 */
export interface TrailingDebounced<Args extends unknown[]> {
  (...args: Args): void;
  cancel(): void;
}

export function trailingDebounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): TrailingDebounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Args): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
