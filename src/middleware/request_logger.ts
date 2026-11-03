import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger';
import type { AppEnv } from '../lib/hono';

/** One line per request. Logs the path only: query strings can hold searched names, phones or CNICs. */
export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const startedAt = performance.now();
  await next();
  logger.info('request', {
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Math.round(performance.now() - startedAt),
  });
};
