import { forgotPasswordSchema, resetPasswordSchema, verifyEmailSchema } from '@shop/shared';
import { acrossTenants } from '../db/tenant_guard';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { redeemLinkToken, sendPasswordResetEmail } from '../lib/auth_emails';
import { ValidationError } from '../lib/errors';
import { publicController } from '../lib/factory';
import { hashPassword } from '../lib/passwords';
import { revokeAllSessions } from '../lib/session';
import { validate } from '../lib/validate';
import { User } from '../models/user';

const INVALID_LINK = 'This link is invalid or has expired';
const ok = { data: { ok: true } } as const;

/** POST /auth/verify-email: the link from the confirmation email. */
export const verifyEmail = publicController.createHandlers(validate('json', verifyEmailSchema), async (c) => {
  const userId = await redeemLinkToken(c.req.valid('json').token, 'verify_email');
  const user = userId && (await acrossTenants(User.findById(userId)).lean());
  if (!user) throw new ValidationError(INVALID_LINK);

  if (!user.emailVerifiedAt) {
    await User.updateOne({ _id: user._id, orgId: user.orgId }, { $set: { emailVerifiedAt: new Date() } });
  }
  return c.json(ok);
});

/** POST /auth/forgot-password: always answers the same, so it doesn't reveal which emails have accounts. */
export const forgotPassword = publicController.createHandlers(validate('json', forgotPasswordSchema), async (c) => {
  const user = await acrossTenants(User.findOne({ email: c.req.valid('json').email })).lean();
  if (user?.active) await sendPasswordResetEmail(user);
  return c.json(ok);
});

/** POST /auth/reset-password: sets the new password and signs the user out everywhere. */
export const resetPassword = publicController.createHandlers(validate('json', resetPasswordSchema), async (c) => {
  const { token, password } = c.req.valid('json');
  const passwordHash = await hashPassword(password);

  await withTransaction(async () => {
    const userId = await redeemLinkToken(token, 'reset_password');
    const user = userId && (await acrossTenants(User.findById(userId)).lean());
    if (!user?.active) throw new ValidationError(INVALID_LINK);

    await User.updateOne(
      { _id: user._id, orgId: user.orgId },
      { $set: { passwordHash, mustChangePassword: false }, $inc: { tokenVersion: 1 } },
    );
    await revokeAllSessions(user._id);
    await recordAudit(user, { action: 'user.password_reset', entity: 'user', entityId: user._id, summary: 'Reset their password by email' });
  });
  return c.json(ok);
});
