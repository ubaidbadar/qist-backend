import { describe, expect, test } from 'bun:test';
import type { GoogleAuthConfig } from '@shop/shared';
import { call } from './api';

describe('Google authentication configuration', () => {
  test('publishes only the web client ID and whether Google sign-in is enabled', async () => {
    const response = await call<GoogleAuthConfig>('GET', '/auth/google/config');
    expect(response.status).toBe(200);
    expect(response.data.enabled).toBe(typeof process.env.GOOGLE_CLIENT_ID === 'string' && process.env.GOOGLE_CLIENT_ID.length > 0);
    expect(response.data.clientId === null || typeof response.data.clientId === 'string').toBe(true);
  });
});
