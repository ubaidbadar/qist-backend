import { changePasswordSchema } from '@shop/shared';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { sendVerificationEmail } from '../lib/auth_emails';
import { fieldDetails, UnauthorizedError, ValidationError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { loadMe, revokeAllSessions, sendSession } from '../lib/session';
import { validate } from '../lib/validate';
import { User } from '../models/user';

/** GET /me */
export const show = authedController.createHandlers(async (c) => {
  const { _id, orgId } = c.var.auth;
  return c.json({ data: await loadMe(_id, orgId) });
});

/** POST /me/password: signs out every other device and returns a fresh session for this one. */
export const changePassword = authedController.createHandlers(validate('json', changePasswordSchema), async (c) => {
  const { auth } = c.var;
  const { currentPassword, newPassword } = c.req.valid('json');
  const user = await User.findOne({ _id: auth._id, orgId: auth.orgId }).select('+passwordHash').lean();
  if (!user) throw new UnauthorizedError();
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ValidationError('Your current password is incorrect', fieldDetails('currentPassword', 'Incorrect password'));
  }
  if (currentPassword === newPassword) {
    throw new ValidationError('Choose a new password', fieldDetails('newPassword', 'Must differ from the current one'));
  }
  const passwordHash = await hashPassword(newPassword);

  const updated = await withTransaction(async () => {
    const changed = await User.findOneAndUpdate(
      { _id: auth._id, orgId: auth.orgId },
      { $set: { passwordHash, mustChangePassword: false }, $inc: { tokenVersion: 1 } },
      { returnDocument: 'after' },
    )
      .select('+tokenVersion')
      .lean();
    await revokeAllSessions(auth._id);
    await recordAudit(auth, { action: 'user.password_changed', entity: 'user', entityId: auth._id, summary: 'Changed their password' });
    return changed;
  });
  if (!updated) throw new UnauthorizedError();
  return sendSession(c, updated);
});

/** POST /me/email-verification: sends a new confirmation link. */
export const resendVerification = authedController.createHandlers(async (c) => {
  const { _id, orgId } = c.var.auth;
  const user = await User.findOne({ _id, orgId }).lean();
  if (user && !user.emailVerifiedAt) await sendVerificationEmail(user);
  return c.json({ data: { ok: true } });
});
