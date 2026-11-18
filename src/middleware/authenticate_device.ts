import { Hono, type MiddlewareHandler } from 'hono';
import { deviceFromToken } from '../lib/device_auth';
import { AppError, UnauthorizedError } from '../lib/errors';
import { recoveryFromToken } from '../lib/device_recovery';
import type { DeviceEnv } from '../lib/hono';

/** Verifies a phone's `<deviceId>.<secret>` credential and loads it as `c.var.device` on every device-API request. */
export const authenticateDevice: MiddlewareHandler<DeviceEnv> = async (c, next) => {
  const [scheme, token] = (c.req.header('Authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new UnauthorizedError();
  const device = await deviceFromToken(token);
  if (device) {
    c.set('device', device);
    return next();
  }

  // Only the existing check-in and command-ack endpoints can participate in recovery.
  // Never let a survival credential access sign-in, key registration, or any staff API.
  const path = c.req.path;
  const isCheckin = c.req.method === 'POST' && path === '/api/v1/device/checkin';
  const isAck = c.req.method === 'POST' &&
    /^\\/api\\/v1\\/device\\/commands\\/[a-fA-F0-9]{24}\\/ack$/.test(path);
  if (!isCheckin && !isAck) throw new UnauthorizedError();

  const recovery = await recoveryFromToken(token);
  if (!recovery || recovery.status === 'revoked') throw new UnauthorizedError();

  if (recovery.status === 'active') {
    // Do NOT send 401 to a cryptographically verified orphan. Existing Locker
    // interprets 401 as permanent revocation and stops polling while it remains Device Owner.
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'Device record unavailable; keep retrying');
  }
  if (recovery.status === 'released' && !isAck) throw new UnauthorizedError();

  c.set('recovery', recovery);
  await next();
};

/** A router whose every route requires an enrolled phone. */
export const deviceRouter = () => new Hono<DeviceEnv>().use(authenticateDevice);
