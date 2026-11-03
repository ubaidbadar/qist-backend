import { beforeAll, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { connectDb } from '../src/db/client';
import { hasDatabase } from './setup';
import { readError } from './helpers';

const app = createApp();
const ALLOWED_ORIGIN = 'http://localhost:3000';

describe('app foundation', () => {
  test('sets a request id and secure headers on every response', async () => {
    const res = await app.request('/api/v1/unknown');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  test('serves the API reference as a page at /docs', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("style-src 'unsafe-inline'");
    expect(await res.text()).toContain('<h2 id="conventions">');
  });

  test('CORS allows only APP_ORIGIN, with credentials', async () => {
    const preflight = (origin: string) =>
      app.request('/api/v1/customers', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });

    const allowed = await preflight(ALLOWED_ORIGIN);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true');

    const other = await preflight('https://evil.example');
    expect(other.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example');
  });

  test('rejects oversized bodies with 413', async () => {
    const res = await app.request('/api/v1/customers', {
      method: 'POST',
      body: 'x'.repeat(200 * 1024),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(413);
    expect((await readError(res)).code).toBe('PAYLOAD_TOO_LARGE');
  });

  test.skipIf(hasDatabase)('health reports the database as down when there is no connection', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ data: { status: 'degraded', db: 'down' } });
  });
});

describe.skipIf(!hasDatabase)('app with Atlas', () => {
  beforeAll(connectDb);

  test('health reports ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'ok', db: 'up' } });
  });
});
