import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { emailSchema } from '@shop/shared';
import { env } from '../config/env';
import { ConflictError, UnauthorizedError } from './errors';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleIdentity {
  googleSub: string;
  email: string;
  fullName: string;
}

/** Verifies the signature and OIDC claims against Google's rotating public keys and our exact web client ID. */
export async function verifyGoogleIdentity(credential: string): Promise<GoogleIdentity> {
  if (!env.GOOGLE_CLIENT_ID) throw new ConflictError('Google sign-in is not configured on this server');

  try {
    const { payload } = await jwtVerify(credential, googleKeys, {
      audience: env.GOOGLE_CLIENT_ID,
      issuer: GOOGLE_ISSUERS,
      algorithms: ['RS256'],
    });

    const parsedEmail = typeof payload.email === 'string' ? emailSchema.safeParse(payload.email) : null;
    if (typeof payload.sub !== 'string' || payload.email_verified !== true || !parsedEmail?.success) {
      throw new UnauthorizedError('Use a Google account with a verified email address');
    }

    const providerName = typeof payload.name === 'string' ? payload.name.trim().slice(0, 80) : '';
    const emailName = parsedEmail.data.split('@')[0].slice(0, 80);
    return {
      googleSub: payload.sub,
      email: parsedEmail.data,
      fullName: providerName.length >= 2 ? providerName : (emailName.length >= 2 ? emailName : 'Google user'),
    };
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ConflictError) throw error;
    if (error instanceof errors.JOSEError) throw new UnauthorizedError('Google sign-in could not be verified. Please try again.');
    throw error;
  }
}
