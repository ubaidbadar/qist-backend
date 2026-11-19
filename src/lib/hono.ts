import { Hono } from 'hono';
import type { RequestIdVariables } from 'hono/request-id';
import type { AuthUser } from './auth_user';
import type { EnrolledDevice } from './device_auth';
import type { CustomerClaims } from './customer_session';

/** Context variables available to every route. */
export type AppEnv = { Variables: RequestIdVariables };

/** Routes behind `authenticate` also get the signed-in user as `c.var.auth`. */
export type AuthEnv = { Variables: RequestIdVariables & { auth: AuthUser } };

/** Routes behind `authenticateDevice` get the enrolled phone as `c.var.device`. */
export type DeviceEnv = { Variables: RequestIdVariables & { device: EnrolledDevice } };
export type CustomerAppEnv = { Variables: RequestIdVariables & { customer: CustomerClaims } };

export const createRouter = () => new Hono<AppEnv>();
