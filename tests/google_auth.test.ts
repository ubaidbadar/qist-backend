import { describe, expect, test } from 'bun:test';
import type { GoogleAuthConfig } from '@shop/shared';
import { call } from './api';
import { createApp } from '../src/app';
import { env } from '../src/config/env';

describe('Google authentication configuration', () => {
  test('credentialed CORS rejects arbitrary Firebase domains', async () => {
    const app = createApp();
    const malicious = await app.request('/api/v1/auth/google/config', {
      headers: { Origin: 'https://untrusted-shop.web.app' },
    });
    expect(malicious.headers.get('access-control-allow-origin')).toBeNull();

    const allowed = await app.request('/api/v1/auth/google/config', {
      headers: { Origin: env.APP_ORIGIN },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(env.APP_ORIGIN);
  });


  test('publishes only the web client ID and whether Google sign-in is enabled', async () => {
    const response = await call<GoogleAuthConfig>('GET', '/auth/google/config');
    expect(response.status).toBe(200);
    expect(response.data.enabled).toBe(typeof process.env.GOOGLE_CLIENT_ID === 'string' && process.env.GOOGLE_CLIENT_ID.length > 0);
    expect(response.data.clientId === null || typeof response.data.clientId === 'string').toBe(true);
  });
});
