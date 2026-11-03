import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env';

const SECRET_BYTES = 32;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const TEMPORARY_PASSWORD_LENGTH = 12;
// No 0/O, 1/l/I: temporary passwords are read out loud and typed by hand.
const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export const randomSecret = () => randomBytes(SECRET_BYTES).toString('base64url');

/** Only this keyed hash of a secret is stored, so a database leak does not leak usable tokens. */
const hashSecret = (secret: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(secret).digest('hex');

/**
 * A token that points at its own document: "<_id>.<secret>". The _id finds the document through the index every
 * document already has; the secret proves the token came from us. Save `_id` and `secretHash` on the document.
 */
export function createSecretToken() {
  const _id = new Types.ObjectId();
  const secret = randomSecret();
  return { _id, token: `${_id}.${secret}`, secretHash: hashSecret(secret) };
}

/**
 * A token that points at a document that already exists, such as a phone: "<_id>.<secret>". Save `secretHash`
 * on that document; the `_id` in the token finds it and the secret proves the token is ours.
 */
export function createTokenFor(_id: Types.ObjectId) {
  const secret = randomSecret();
  return { token: `${_id}.${secret}`, secretHash: hashSecret(secret) };
}

/** Splits a token from a cookie or link; null when it isn't shaped like one of ours. */
export function readSecretToken(token: string | undefined) {
  const [id = '', secret = '', ...rest] = (token ?? '').split('.');
  if (!OBJECT_ID_PATTERN.test(id) || !secret || rest.length > 0) return null;
  return { _id: new Types.ObjectId(id), secret };
}

/** Constant-time comparison, so response times don't reveal how close a guess was. */
export function secretMatches(secret: string, secretHash: string) {
  const expected = Buffer.from(secretHash, 'hex');
  const actual = Buffer.from(hashSecret(secret), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function temporaryPassword() {
  return Array.from(
    { length: TEMPORARY_PASSWORD_LENGTH },
    () => TEMPORARY_PASSWORD_ALPHABET[randomInt(TEMPORARY_PASSWORD_ALPHABET.length)],
  ).join('');
}
