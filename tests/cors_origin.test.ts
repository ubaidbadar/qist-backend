import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { parseEnv } from '../src/config/env';

const app = createApp();

describe('credentialed API origin policy', () => {
  test('rejects unrelated Firebase projects', async () => {
    const response = await app.request('/api/v1/auth/google/config', {
      headers: { Origin: 'https://unrelated-project.web.app' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
  test('allows the configured Qist frontend origin', async () => {
    const response = await app.request('/api/v1/auth/google/config', {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });
  test('parses explicit extra origins and rejects paths or malformed hosts', () => {
    const base = {
      MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB: 'shop',
      JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32),
      INTERNAL_JOB_SECRET: 'c'.repeat(32), APP_ORIGIN: 'https://qist-a.web.app',
    };
    const configured = parseEnv({ ...base, APP_ADDITIONAL_ORIGINS: 'https://qist-a--pr15-preview.web.app' });
    expect(configured.APP_ADDITIONAL_ORIGINS).toEqual(['https://qist-a--pr15-preview.web.app']);
    expect(() => parseEnv({ ...base, APP_ADDITIONAL_ORIGINS: 'https://example.com/path' })).toThrow('APP_ADDITIONAL_ORIGINS');
    expect(() => parseEnv({ ...base, APP_ADDITIONAL_ORIGINS: 'not-a-url' })).toThrow('APP_ADDITIONAL_ORIGINS');
  });
});
