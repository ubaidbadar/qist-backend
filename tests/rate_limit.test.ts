import { expect, test } from 'bun:test';
import { createRouter } from '../src/lib/hono';
import { onError } from '../src/middleware/error_handler';
import { rateLimit } from '../src/middleware/rate_limit';
import { readError } from './helpers';

test('rejects requests over the limit with 429 and Retry-After', async () => {
  const app = createRouter().use(rateLimit({ windowMs: 60_000, max: 2 })).get('/login', (c) => c.text('ok'));
  app.onError(onError);

  expect((await app.request('/login')).status).toBe(200);
  expect((await app.request('/login')).status).toBe(200);
  const limited = await app.request('/login');
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect((await readError(limited)).code).toBe('RATE_LIMITED');
});
