import { Hono, type MiddlewareHandler } from 'hono';
import { Types } from 'mongoose';
import { acrossTenants } from '../db/tenant_guard';
import { authUserOf } from '../lib/auth_user';
import { UnauthorizedError } from '../lib/errors';
import type { AuthEnv } from '../lib/hono';
import { verifyAccessToken } from '../lib/jwt';
import { User } from '../models/user';

/**
 * Verifies the access token and loads the user on every request, so a deactivation, role change or password
 * change takes effect at once. Organization suspension is enforced at sign-in and refresh.
 */
export const authenticate: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const [scheme, token] = (c.req.header('Authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new UnauthorizedError();

  const claims = await verifyAccessToken(token);
  if (!Types.ObjectId.isValid(claims.sub)) throw new UnauthorizedError();
  // The token names the user; the organization check comes right after.
  const user = await acrossTenants(User.findById(claims.sub).select('+tokenVersion')).lean();
  if (!user?.active || user.tokenVersion !== claims.ver || String(user.orgId) !== claims.org) {
    throw new UnauthorizedError();
  }

  c.set('auth', authUserOf(user));
  await next();
};

/** A router whose every route requires a signed-in user. */
export const authedRouter = () => new Hono<AuthEnv>().use(authenticate);
