import * as device from '../controllers/device_controller';
import { createRouter } from '../lib/hono';
import { env } from '../config/env';
import { rateLimit } from '../middleware/rate_limit';
import { deviceRouter } from '../middleware/authenticate_device';

/**
 * The API the Android app talks to (Phase 2). Enrolment redeems the one-time QR token; everything after it is
 * behind the phone's own `<deviceId>.<secret>` credential, never a user session.
 */
const customerAuthLimit = rateLimit({ windowMs: 60_000, max: 10, enabled: env.NODE_ENV !== 'test' });

export const deviceApiRoutes = createRouter()
  .post('/enroll', ...device.enroll)
  .route(
    '/',
    deviceRouter()
      .post('/checkin', ...device.checkin)
      .post('/customer-auth/issue', customerAuthLimit, ...device.issueCustomerAuthHandoff)
      .post('/commands/:id/ack', ...device.acknowledge),
  );
