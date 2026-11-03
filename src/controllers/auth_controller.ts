import { loginSchema, signupSchema } from '@shop/shared';
import { acrossTenants } from '../db/tenant_guard';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { sendVerificationEmail } from '../lib/auth_emails';
import { ConflictError, fieldDetails, ForbiddenError, UnauthorizedError } from '../lib/errors';
import { publicController } from '../lib/factory';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../lib/passwords';
import { clearRefreshCookie, readRefreshCookie } from '../lib/refresh_cookie';
import { endSession, sendSession, useRefreshToken } from '../lib/session';
import { validate } from '../lib/validate';
import { Branch } from '../models/branch';
import { Org } from '../models/org';
import { User } from '../models/user';

/** POST /auth/signup: creates the organization, its first branch and the owner, then signs the owner in. */
export const signup = publicController.createHandlers(validate('json', signupSchema), async (c) => {
  const input = c.req.valid('json');
  if (await acrossTenants(User.exists({ email: input.email }))) {
    throw new ConflictError('An account with this email already exists', fieldDetails('email', 'Already registered'));
  }
  const passwordHash = await hashPassword(input.password);

  const owner = await withTransaction(async () => {
    const org = await Org.create({ name: input.orgName });
    const branch = await Branch.create({ orgId: org._id, name: input.branchName });
    const user = await User.create({ orgId: org._id, email: input.email, passwordHash, fullName: input.fullName, role: 'owner' });
    await recordAudit(user, {
      action: 'org.created',
      entity: 'org',
      entityId: org._id,
      branchId: branch._id,
      summary: `Created ${org.name} with branch ${branch.name}`,
    });
    return user;
  });

  await sendVerificationEmail(owner);
  return sendSession(c, owner, 201);
});

/** POST /auth/login */
export const login = publicController.createHandlers(validate('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const user = await acrossTenants(User.findOne({ email }).select('+passwordHash +tokenVersion')).lean();
  // An unknown email takes as long as a wrong password, so timing doesn't reveal who has an account.
  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummy(password);
  if (!user || !passwordOk) throw new UnauthorizedError('Email or password is incorrect');
  if (!user.active) throw new ForbiddenError('Your account has been deactivated. Ask the owner to reactivate it.');

  await User.updateOne({ _id: user._id, orgId: user.orgId }, { $set: { lastLoginAt: new Date() } });
  return sendSession(c, user);
});

/** POST /auth/refresh: exchanges the refresh cookie for a new session. */
export const refresh = publicController.createHandlers(async (c) => {
  try {
    return await sendSession(c, await useRefreshToken(readRefreshCookie(c)));
  } catch (err) {
    clearRefreshCookie(c); // a refresh that failed once will fail again; drop the dead cookie
    throw err;
  }
});

/** POST /auth/logout */
export const logout = publicController.createHandlers(async (c) => {
  await endSession(readRefreshCookie(c));
  clearRefreshCookie(c);
  return c.json({ data: { ok: true } });
});
