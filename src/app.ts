import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './config/env';
import { PayloadTooLargeError } from './lib/errors';
import { createRouter } from './lib/hono';
import { errorResponse, onError, onNotFound } from './middleware/error_handler';
import { requestLogger } from './middleware/request_logger';
import { apiRoutes } from './routes';
import { docsRoutes } from './routes/docs';
import { healthRoutes } from './routes/health';

/** Request bodies are small JSON; CNIC images go straight to R2 through presigned URLs. */
const JSON_BODY_LIMIT_BYTES = 100 * 1024;
const CORS_MAX_AGE_SECONDS = 600;

export function createApp() {
  const app = createRouter();

  app.use(requestId());
  app.use(requestLogger);
  // Before the secure headers: the page styles itself inline, which the API's `default-src 'none'` would block.
  if (env.NODE_ENV !== 'production') app.route('/docs', docsRoutes);
  // Public shop logos are displayed by a separate Firebase-hosted origin. Apply the
  // response override outside secureHeaders so its default same-origin CORP cannot block images.
  app.use('/api/v1/public/orgs/*', async (c, next) => {
    await next();
    c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  });
  app.use(secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }));
  app.use(
    '/api/*',
    cors({
      origin: (origin) => {
        if (!origin) return env.APP_ORIGIN;
        if (origin === env.APP_ORIGIN) return origin;
        if (env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
        // Never trust every Firebase Hosting project: credentialed requests could expose sessions.
        if (env.APP_ADDITIONAL_ORIGINS.includes(origin)) return origin;
        return null;
      },
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Refresh-Token'],
      exposeHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: CORS_MAX_AGE_SECONDS,
    }),
  );
  app.use('/api/*', bodyLimit({ maxSize: JSON_BODY_LIMIT_BYTES, onError: (c) => errorResponse(c, new PayloadTooLargeError()) }));

  app.route('/health', healthRoutes);
  app.route('/api/v1', apiRoutes);

  app.onError(onError);
  app.notFound(onNotFound);
  return app;
}

