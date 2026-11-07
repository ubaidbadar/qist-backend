import { env } from '../config/env';
import * as controller from '../controllers/customer_app_controller';
import { authenticateCustomer } from '../lib/customer_session';
import { createRouter } from '../lib/hono';
import { rateLimit } from '../middleware/rate_limit';

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, enabled: env.NODE_ENV !== 'test' });
const recoveryLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, enabled: env.NODE_ENV !== 'test' });
export const customerAppRoutes = createRouter()
  .post('/auth/start', authLimit, ...controller.start)
  .post('/auth/request-code', recoveryLimit, ...controller.requestCode)
  .post('/auth/verify-code', authLimit, ...controller.verifyCode)
  .post('/auth/set-password', authLimit, ...controller.setPassword)
  .post('/auth/login', authLimit, ...controller.login)
  .post('/auth/forgot-password', recoveryLimit, ...controller.requestReset)
  .post('/auth/reset-password', authLimit, ...controller.resetPassword)
  .use('*', authenticateCustomer)
  .get('/overview', ...controller.overview)
  .get('/payments', ...controller.payments)
  .post('/auth/logout', ...controller.logout);
