/**
 * fetch() with a timeout and an optional external AbortSignal, combined
 * manually (AbortSignal.any is not guaranteed in every Even Hub WebView).
 */

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super('Request was cancelled');
    this.name = 'RequestCancelledError';
  }
}

export interface AbortableRequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function abortableFetch(
  url: string,
  init: RequestInit,
  options: AbortableRequestOptions,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      clearTimeout(timer);
      throw new RequestCancelledError();
    }
    external.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw timedOut ? new RequestTimeoutError(options.timeoutMs) : new RequestCancelledError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}
