/**
 * Request/turn ID generation. crypto.randomUUID is preferred; older WebViews
 * without it fall back to a random token that still satisfies the backend's
 * requestId constraints (non-empty, ≤ 64 chars).
 */
export function makeId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
