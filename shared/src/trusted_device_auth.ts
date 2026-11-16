import { z } from 'zod';
import { mobileSchema } from './identifiers';
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const id = z.string().regex(/^[a-f0-9]{24}$/);
export const localSigninSchema = z.object({ nonce });
export const remoteSigninSchema = z.object({ nonce, phone: mobileSchema });
export const signinClaimSchema = z.object({ nonce, requestId: id });
export const registerSigninKeySchema = z.object({
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{80,250}={0,2}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{80,110}$/),
});
export const approveSigninSchema = z.object({ requestId: id,
  decision: z.enum(['approve', 'deny']),
  number: z.string().regex(/^\d{3}$/).optional(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{80,110}$/),
});
