import type { MiddlewareHandler } from 'hono';
import { can, type Permission } from '@shop/shared';
import { ForbiddenError } from '../lib/errors';
import type { AuthEnv } from '../lib/hono';

/** Enforces the shared permission map (docs/plan.md §4) on the server. */
export const requirePermission =
  (permission: Permission): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    if (!can(c.var.auth.role, permission)) throw new ForbiddenError();
    await next();
  };
