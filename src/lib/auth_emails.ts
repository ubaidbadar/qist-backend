import type { Types } from 'mongoose';
import { APP_NAME } from '@shop/shared';
import { env } from '../config/env';
import { EmailToken, type EmailTokenPurpose } from '../models/email_token';
import { sendEmailInBackground } from './email';
import { createSecretToken, readSecretToken, secretMatches } from './tokens';

const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_PASSWORD_TTL_MS = 30 * 60 * 1000;

interface Recipient {
  _id: Types.ObjectId;
  email: string;
  fullName: string;
}

/** A new link token; older unused links for the same purpose stop working. */
async function issueLinkToken(userId: Types.ObjectId, purpose: EmailTokenPurpose, ttlMs: number) {
  const now = new Date();
  await EmailToken.updateMany({ userId, purpose, usedAt: null }, { $set: { usedAt: now } });
  const { _id, token, secretHash } = createSecretToken();
  await EmailToken.create({ _id, userId, purpose, secretHash, expiresAt: new Date(now.getTime() + ttlMs) });
  return token;
}

/** Uses up the token from an emailed link. Returns the user it was sent to, or null if invalid, used or expired. */
export async function redeemLinkToken(token: string, purpose: EmailTokenPurpose) {
  const parsed = readSecretToken(token);
  if (!parsed) return null;
  const record = await EmailToken.findById(parsed._id).lean();
  if (!record || record.purpose !== purpose || !secretMatches(parsed.secret, record.secretHash)) return null;

  const claimed = await EmailToken.findOneAndUpdate(
    { _id: record._id, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  return claimed ? record.userId : null;
}

export async function sendVerificationEmail(user: Recipient) {
  const token = await issueLinkToken(user._id, 'verify_email', VERIFY_EMAIL_TTL_MS);
  sendEmailInBackground({
    to: user.email,
    subject: `Confirm your email for ${APP_NAME}`,
    text: `Hi ${user.fullName},\n\nConfirm your email address by opening this link:\n${env.APP_ORIGIN}/verify-email?token=${token}\n\nThe link expires in 24 hours.`,
  });
}

export async function sendPasswordResetEmail(user: Recipient) {
  const token = await issueLinkToken(user._id, 'reset_password', RESET_PASSWORD_TTL_MS);
  sendEmailInBackground({
    to: user.email,
    subject: `Reset your ${APP_NAME} password`,
    text: `Hi ${user.fullName},\n\nChoose a new password here:\n${env.APP_ORIGIN}/reset-password?token=${token}\n\nThe link expires in 30 minutes. If you didn't ask for this, you can ignore this email.`,
  });
}
