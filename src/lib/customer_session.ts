import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import { env } from '../config/env';
import type { CustomerAppEnv } from './hono';
import { UnauthorizedError } from './errors';

const claimsSchema = z.object({ sub: z.string().regex(/^[a-f0-9]{24}$/), ver: z.number().int().nonnegative(), sid: z.uuid() });
export type CustomerClaims = z.infer<typeof claimsSchema>;
const key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
export const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const options = { issuer: 'qist-api', audience: 'qist-customer', algorithms: ['HS256'] };

export const signCustomerToken = (claims: CustomerClaims, expiresAt: Date) => new SignJWT({ ver: claims.ver, sid: claims.sid })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(claims.sub).setIssuer(options.issuer).setAudience(options.audience)
  .setIssuedAt().setExpirationTime(Math.floor(expiresAt.getTime() / 1000)).sign(key);

export async function verifyCustomerToken(token: string): Promise<CustomerClaims> {
  try {
    const { payload } = await jwtVerify(token, key, options);
    return claimsSchema.parse(payload);
  } catch (err) {
    if (err instanceof errors.JOSEError || err instanceof z.ZodError) throw new UnauthorizedError();
    throw err;
  }
}

/** Database authorization is included in each endpoint's aggregate/atomic write, never a duplicate middleware read. */
export const authenticateCustomer: MiddlewareHandler<CustomerAppEnv> = async (c, next) => {
  const authorization = c.req.header('Authorization');
  if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedError();
  c.set('customer', await verifyCustomerToken(authorization.slice(7)));
  await next();
};
