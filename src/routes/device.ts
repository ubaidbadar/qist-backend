import * as device from '../controllers/device_controller';
import { createRouter } from '../lib/hono';
import { deviceRouter } from '../middleware/authenticate_device';

/**
 * The API the Android app talks to (Phase 2). Enrolment redeems the one-time QR token; everything after it is
 * behind the phone's own `<deviceId>.<secret>` credential, never a user session.
 */
export const deviceApiRoutes = createRouter()
  .post('/enroll', ...device.enroll)
  .route(
    '/',
    deviceRouter()
      .post('/checkin', ...device.checkin)
      .post('/commands/:id/ack', ...device.acknowledge),
  );
