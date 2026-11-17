import { customerDocumentRoutes } from '../documents/routes';
import { AppError } from '../lib/errors';
import { env } from '../config/env';
import * as trusted from '../controllers/trusted_device_auth_controller';
import * as controller from '../controllers/customer_app_controller';
import { authenticateCustomer } from '../lib/customer_session';
import { createRouter } from '../lib/hono';
import { rateLimit } from '../middleware/rate_limit';

const pushLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, enabled: env.NODE_ENV !== 'test' });
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, enabled: env.NODE_ENV !== 'test' });
const signinPollLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, enabled: env.NODE_ENV !== 'test' });
const recoveryLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, enabled: env.NODE_ENV !== 'test' });
export const customerAppRoutes = createRouter()
  .get('/config', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { maintenance: env.CUSTOMER_APP_MAINTENANCE } });
  })
  .use('*', async (c, next) => {
    // Account deletion remains available to an authenticated customer during app maintenance/upgrades.
    if (c.req.method === 'DELETE' && c.req.path.endsWith('/account')) return next();
    if (env.CUSTOMER_APP_MAINTENANCE) throw new AppError('MAINTENANCE_MODE', 503, 'Qist is under maintenance. Please try again shortly.');
    const version = c.req.header('X-Customer-App-Version');
    if (version !== undefined && !/^\d{1,10}$/.test(version)) throw new AppError('VALIDATION_ERROR', 400, 'Invalid app version');
    return next();
  })
  .post('/auth/device/local', authLimit, ...trusted.localChallenge)
  .post('/auth/device/request', recoveryLimit, ...trusted.remoteChallenge)
  .post('/auth/device/claim', signinPollLimit, ...trusted.claim)
  .post('/auth/device/cancel', authLimit, ...trusted.cancel)
  .post('/auth/start', authLimit, ...controller.start)
  .post('/auth/request-code', recoveryLimit, ...controller.requestCode)
  .post('/auth/verify-code', authLimit, ...controller.verifyCode)
  .post('/auth/set-password', authLimit, ...controller.setPassword)
  .post('/auth/login', authLimit, ...controller.login)
  .post('/auth/device/exchange', authLimit, ...controller.exchangeDeviceHandoff)
  .post('/auth/forgot-password', recoveryLimit, ...controller.requestReset)
  .post('/auth/reset-password', authLimit, ...controller.resetPassword)
  .use('*', authenticateCustomer)
  .route('/documents', customerDocumentRoutes)
  .delete('/account', authLimit, ...controller.deleteAccount)
  .post('/push-token', pushLimit, ...controller.registerPush)
  .delete('/push-token', ...controller.unregisterPush)
  .post('/notifications/read', ...controller.readNotifications)
  .get('/overview', ...controller.overview)
  .get('/payments', ...controller.payments)
  .post('/auth/logout', ...controller.logout);
