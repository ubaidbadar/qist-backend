import type { Context } from 'hono';
import { googleAuthSchema, loginSchema, signupSchema } from '@shop/shared';
import { acrossTenants } from '../db/tenant_guard';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { sendVerificationEmail } from '../lib/auth_emails';
import { ConflictError, fieldDetails, ForbiddenError, UnauthorizedError } from '../lib/errors';
import { publicController } from '../lib/factory';
import { decodeOrgLogo } from '../lib/org_logo';
import { verifyGoogleIdentity } from '../lib/google_identity';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../lib/passwords';
import { clearRefreshCookie, readRefreshCookie } from '../lib/refresh_cookie';
import { endSession, sendSession, useRefreshToken } from '../lib/session';
import { validate } from '../lib/validate';
import { Branch } from '../models/branch';
import { Org } from '../models/org';
import { OrgLogo } from '../models/org_logo';
import { User } from '../models/user';
import { env } from '../config/env';

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/** Public Google configuration. The client ID is public by design; the client secret is never sent to the browser. */
export const googleConfig = publicController.createHandlers(async (c) => {
  return c.json({ data: { enabled: Boolean(env.GOOGLE_CLIENT_ID), clientId: env.GOOGLE_CLIENT_ID ?? null } });
});

/**
 * POST /auth/google
 * Existing users sign in by Google's stable subject ID. Previously verified Qist emails can be
 * be linked atomically on first Google sign-in. New users complete shop and password setup here.
 */
export const googleSignIn = publicController.createHandlers(validate('json', googleAuthSchema), async (c) => {
  const { credential, onboarding } = c.req.valid('json');
  const identity = await verifyGoogleIdentity(credential);

  const matches = await acrossTenants(
    User.find({ $or: [{ googleSub: identity.googleSub }, { email: identity.email }] })
      .select('+googleSub +tokenVersion')
      .limit(2)
      .lean(),
  );

  if (matches.length > 1) {
    throw new ConflictError('This Google account and email are associated with different Qist accounts. Contact support before continuing.');
  }

  const user = matches[0];
  if (user) {
    if (user.googleSub && user.googleSub !== identity.googleSub) {
      throw new ConflictError('This email is already connected to a different Google account. Sign in using your existing method.');
    }
    if (!user.active) throw new ForbiddenError('Your account has been deactivated. Ask the shop owner to reactivate it.');

    if (!user.googleSub) {
      // A matching address is linked only if the same address was already verified by Qist.
      // Google verification alone is not sufficient for an older third-party-email account.
      if (!user.emailVerifiedAt) {
        throw new ConflictError('This Qist account needs email verification before Google sign-in can be linked. Sign in with your email and password and verify your email first.');
      }

      try {
        const linked = await User.findOneAndUpdate(
          {
            _id: user._id,
            orgId: user.orgId,
            emailVerifiedAt: { $ne: null },
            $or: [{ googleSub: { $exists: false } }, { googleSub: null }],
          },
          { $set: { googleSub: identity.googleSub, lastLoginAt: new Date() } },
          { returnDocument: 'after' },
        ).select('+googleSub +tokenVersion').lean();

        if (!linked || linked.googleSub !== identity.googleSub) {
          throw new ConflictError('This Qist account is already connected to a different Google account.');
        }

        await recordAudit(linked, {
          action: 'user.google_connected',
          entity: 'user',
          entityId: linked._id,
          summary: 'Connected Google sign-in to an existing verified Qist account',
        });
        return sendSession(c, linked);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new ConflictError('This Google account is already connected to another Qist user.');
        }
        throw error;
      }
    }

    return sendSession(c, user);
  }

  if (!onboarding) {
    return c.json({
      data: {
        onboardingRequired: true as const,
        profile: { fullName: identity.fullName, email: identity.email },
      },
    });
  }

  const logoData = onboarding.logo ? decodeOrgLogo(onboarding.logo) : null;
  const passwordHash = await hashPassword(onboarding.password);
  const now = new Date();

  try {
    const owner = await withTransaction(async () => {
      const org = await Org.create({ name: onboarding.shopName, logoUpdatedAt: logoData ? now : null });
      const branch = await Branch.create({
        orgId: org._id,
        name: 'Main Branch',
        phone: onboarding.phone,
        address: onboarding.address,
      });
      const created = await User.create({
        orgId: org._id,
        email: identity.email,
        googleSub: identity.googleSub,
        passwordHash,
        passwordEnabled: true,
        fullName: onboarding.fullName,
        role: 'owner',
        emailVerifiedAt: now,
        lastLoginAt: now,
      });

      if (logoData && onboarding.logo) {
        await OrgLogo.create({ _id: org._id, contentType: onboarding.logo.contentType, data: logoData });
      }

      await recordAudit(created, {
        action: 'org.created',
        entity: 'org',
        entityId: org._id,
        branchId: branch._id,
        summary: 'Created a retailer account using Google sign-in',
        metadata: { signupMethod: 'google', logoAdded: Boolean(logoData) },
      });

      return created;
    });

    return sendSession(c, owner, 201);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    // A concurrent Google signup may have won the unique email/subject index race.
    const existing = await acrossTenants(
      User.findOne({ googleSub: identity.googleSub }).select('+googleSub +tokenVersion').lean(),
    );
    if (existing?.googleSub === identity.googleSub && existing.active) return sendSession(c, existing);
    throw new ConflictError('An account with this email already exists. Sign in using that account instead.');
  }
});

/** POST /auth/signup: creates the organization, its first branch and the owner, then signs the owner in. */
export const signup = publicController.createHandlers(validate('json', signupSchema), async (c) => {
  const input = c.req.valid('json');
  const passwordHash = await hashPassword(input.password);

  const owner = await withTransaction(async () => {
    const org = await Org.create({ name: input.orgName });
    const branch = await Branch.create({ orgId: org._id, name: input.branchName });
    const user = await User.create({ orgId: org._id, passwordHash, fullName: input.fullName, email: input.email, role: 'owner' });
    await recordAudit(user, {
      action: 'org.created',
      entity: 'org',
      entityId: org._id,
      branchId: branch._id,
      summary: 'Created a retailer account using email and password',
    });
    return user;
  }).catch((error: unknown) => {
    // The unique email index is the source of truth; avoid a separate preflight read and handle signup races.
    if (isDuplicateKeyError(error)) {
      throw new ConflictError('An account with this email already exists', fieldDetails('email', 'Already registered'));
    }
    throw error;
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

async function extractRefreshToken(c: Context): Promise<string | undefined> {
  const cookie = readRefreshCookie(c);
  if (cookie) return cookie;

  const header = c.req.header('x-refresh-token');
  if (header) return header;

  try {
    const body = (await c.req.json()) as Record<string, unknown> | null;
    if (body && typeof body.refreshToken === 'string') return body.refreshToken;
  } catch {
    // Body is empty or not JSON
  }
  return undefined;
}

/** POST /auth/refresh: exchanges the refresh cookie or token for a new session. */
export const refresh = publicController.createHandlers(async (c) => {
  try {
    const token = await extractRefreshToken(c);
    return await sendSession(c, await useRefreshToken(token));
  } catch (err) {
    clearRefreshCookie(c); // a refresh that failed once will fail again; drop the dead cookie
    throw err;
  }
});

/** POST /auth/logout */
export const logout = publicController.createHandlers(async (c) => {
  const token = await extractRefreshToken(c);
  await endSession(token);
  clearRefreshCookie(c);
  return c.json({ data: { ok: true } });
});
