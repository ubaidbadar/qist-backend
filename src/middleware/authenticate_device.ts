import { Hono, type MiddlewareHandler } from 'hono';
import { deviceFromToken } from '../lib/device_auth';
import { UnauthorizedError } from '../lib/errors';
import type { DeviceEnv } from '../lib/hono';

/** Verifies a phone's `<deviceId>.<secret>` credential and loads it as `c.var.device` on every device-API request. */
export const authenticateDevice: MiddlewareHandler<DeviceEnv> = async (c, next) => {
  const [scheme, token] = (c.req.header('Authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new UnauthorizedError();
  const device = await deviceFromToken(token);
  if (!device) throw new UnauthorizedError();
  c.set('device', device);
  await next();
};

/** A router whose every route requires an enrolled phone. */
export const deviceRouter = () => new Hono<DeviceEnv>().use(authenticateDevice);
