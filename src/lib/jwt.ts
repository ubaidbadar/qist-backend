import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { env } from '../config/env';
import { UnauthorizedError } from './errors';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const ALGORITHM = 'HS256';
const ISSUER = 'qist-api';
const AUDIENCE = 'qist-portal';
const key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

const claimsSchema = z.object({ sub: z.string(), org: z.string(), ver: z.number().int() });

/** `ver` is the user's tokenVersion: bumping it (password change, deactivation) voids every access token. */
export type AccessClaims = z.infer<typeof claimsSchema>;

export const signAccessToken = ({ sub, org, ver }: AccessClaims) =>
  new SignJWT({ org, ver })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE, algorithms: [ALGORITHM] });
    return claimsSchema.parse(payload);
  } catch (err) {
    if (err instanceof errors.JOSEError || err instanceof z.ZodError) throw new UnauthorizedError();
    throw err;
  }
}
