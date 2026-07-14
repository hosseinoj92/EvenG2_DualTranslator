import { describe, expect, it } from 'vitest';
import type { ApiErrorResponse, HealthResponse } from '@turntranslate/shared';
import { BASE_URL, buildApp, readJson, testConfig } from './helpers';

describe('health route', () => {
  it('returns service identity on GET', async () => {
    const app = buildApp();
    const response = await app(new Request(`${BASE_URL}/health`));
    expect(response.status).toBe(200);
    const body = await readJson<HealthResponse>(response);
    expect(body).toEqual({ status: 'ok', service: 'turntranslate-api' });
  });

  it('rejects POST with 405', async () => {
    const app = buildApp();
    const response = await app(new Request(`${BASE_URL}/health`, { method: 'POST' }));
    expect(response.status).toBe(405);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('unknown routes', () => {
  it('returns a typed 404', async () => {
    const app = buildApp();
    const response = await app(new Request(`${BASE_URL}/nope`));
    expect(response.status).toBe(404);
    const body = await readJson<ApiErrorResponse>(response);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('CORS', () => {
  it('answers preflight from an allowed origin with allow headers', async () => {
    const app = buildApp({ config: testConfig({ allowedOrigins: 'https://app.example' }) });
    const response = await app(
      new Request(`${BASE_URL}/api/v1/interpret`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example',
          'access-control-request-method': 'POST',
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('does not reflect a disallowed origin', async () => {
    const app = buildApp({ config: testConfig({ allowedOrigins: 'https://app.example' }) });
    const response = await app(
      new Request(`${BASE_URL}/api/v1/interpret`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts localhost origins only when local dev mode is on', async () => {
    const devApp = buildApp({ config: testConfig({ allowLocalDev: 'true' }) });
    const devResponse = await devApp(
      new Request(`${BASE_URL}/health`, { headers: { origin: 'http://localhost:5173' } }),
    );
    expect(devResponse.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const prodApp = buildApp({ config: testConfig({ allowLocalDev: 'false' }) });
    const prodResponse = await prodApp(
      new Request(`${BASE_URL}/health`, { headers: { origin: 'http://localhost:5173' } }),
    );
    expect(prodResponse.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('adds CORS headers to normal responses for allowed origins', async () => {
    const app = buildApp();
    const response = await app(
      new Request(`${BASE_URL}/health`, { headers: { origin: 'https://app.example' } }),
    );
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
