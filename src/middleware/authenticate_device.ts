import { Hono, type MiddlewareHandler } from 'hono';
import { acrossTenants } from '../db/tenant_guard';
import { recoveryFromToken } from '../lib/device_recovery';
import { deviceFromToken } from '../lib/device_auth';
import { AppError, UnauthorizedError } from '../lib/errors';
import type { DeviceEnv } from '../lib/hono';
import { Device } from '../models/device';

/**
 * Normal requests require a currently enrolled phone. A verified survival
 * record is accepted ONLY for check-in / release acknowledgement and ONLY
 * when the primary business Device record no longer exists.
 */
export const authenticateDevice: MiddlewareHandler<DeviceEnv> = async (c, next) => {
  const [scheme, token] = (c.req.header('Authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new UnauthorizedError();

  const device = await deviceFromToken(token);
  if (device) {
    c.set('device', device);
    return next();
  }

  const path = c.req.path;
  const isCheckin = c.req.method === 'POST' && path === '/api/v1/device/checkin';
  const isAck = c.req.method === 'POST' &&
    new RegExp('^/api/v1/device/commands/[a-fA-F0-9]{24}/ack$').test(path);
  if (!isCheckin && !isAck) throw new UnauthorizedError();

  const recovery = await recoveryFromToken(token);
  if (!recovery || recovery.status === 'revoked') throw new UnauthorizedError();

  // Never revive a stale credential when the business record was restored or
  // replaced by a different enrollment with the same ObjectId.
  if (await acrossTenants(Device.exists({ _id: recovery._id }))) throw new UnauthorizedError();

  if (recovery.status === 'active') {
    // The original Locker permanently stands down on 401; 503 makes it retry.
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'Device record unavailable; keep retrying');
  }
  if (recovery.status === 'released' && !isAck) throw new UnauthorizedError();

  c.set('recovery', recovery);
  await next();
};

export const deviceRouter = () => new Hono<DeviceEnv>().use(authenticateDevice);
