import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  customerLoginSchema,
  customerOverviewQuerySchema,
  customerPaymentsQuerySchema,
  customerRecoverySchema,
  customerDeviceAuthExchangeSchema,
  customerSetPasswordSchema,
  customerPushSchema,
  customerReadNotificationsSchema,
} from '@shop/shared';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { loadCustomerOverview, loadCustomerPayments } from '../lib/customer_data';
import { CUSTOMER_SESSION_MS, signCustomerToken } from '../lib/customer_session';
import { AppError, UnauthorizedError, ValidationError } from '../lib/errors';
import { customerAppController, publicController } from '../lib/factory';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../lib/passwords';
import { validate } from '../lib/validate';
import { Customer } from '../models/customer';
import { CustomerNotification } from '../models/customer_notification';
import { CustomerPushToken } from '../models/customer_push_token';
import { CustomerAccount } from '../models/customer_account';
import { validateSigninHandoff } from '../lib/trusted_device_auth';
import { CustomerAuthHandoff } from '../models/customer_auth_handoff';

const RESET_TTL = 5 * 60 * 1000;
const setupDigest = (phone: string, token: string) =>
  createHmac('sha256', env.JWT_REFRESH_SECRET).update(`customer-setup:${phone}:${token}`).digest('hex');

/** Password verification requires a read, then a conditional atomic write; no user/retailer refetch. */
export const login = publicController.createHandlers(validate('json', customerLoginSchema), async (c) => {
  const { phone, password } = c.req.valid('json');
  const account = await CustomerAccount.findOne({ phone }).select('+passwordHash +tokenVersion').lean();
  const valid = account?.passwordHash
    ? await verifyPassword(password, account.passwordHash)
    : await verifyAgainstDummy(password);
  if (!account || !valid) throw new UnauthorizedError('Phone number or password is incorrect');
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MS);
  const updated = await CustomerAccount.findOneAndUpdate(
    { _id: account._id, tokenVersion: account.tokenVersion, passwordHash: account.passwordHash },
    { $push: { sessions: { $each: [{ id, expiresAt }], $slice: -5 } } },
    { returnDocument: 'after' },
  )
    .select('_id +tokenVersion')
    .lean();
  if (!updated) throw new UnauthorizedError('Please try signing in again');
  const accessToken = await signCustomerToken(
    { sub: String(updated._id), ver: updated.tokenVersion, sid: id },
    expiresAt,
  );
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { accessToken, expiresAt: expiresAt.toISOString() } });
});

/** Exact-phone eligibility lookup; never returns customer, retailer or contract details. */
async function signinRoute(phone: string) {
  const [result] = await Customer.aggregate<{ hasPassword: boolean }>([
    { $match: { orgId: { $exists: true }, phone } },
    {
      $lookup: {
        from: 'orgs',
        localField: 'orgId',
        foreignField: '_id',
        pipeline: [{ $match: { status: 'active' } }, { $project: { _id: 1 } }],
        as: 'org',
      },
    },
    { $match: { 'org.0': { $exists: true } } },
    {
      $lookup: {
        from: 'contracts',
        let: { customer: '$_id', org: '$orgId' },
        pipeline: [
          {
            $match: {
              status: { $in: ['active', 'defaulted', 'completed'] },
              $expr: { $and: [{ $eq: ['$customerId', '$$customer'] }, { $eq: ['$orgId', '$$org'] }] },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'plans',
      },
    },
    { $match: { 'plans.0': { $exists: true } } },
    { $limit: 1 },
    {
      $lookup: {
        from: 'customer_accounts',
        localField: 'phone',
        foreignField: 'phone',
        pipeline: [{ $project: { hasPassword: { $ne: [{ $ifNull: ['$passwordHash', null] }, null] } } }],
        as: 'account',
      },
    },
    { $project: { _id: 0, hasPassword: { $ifNull: [{ $first: '$account.hasPassword' }, false] } } },
  ]);
  return result;
}

export const start = publicController.createHandlers(validate('json', customerRecoverySchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { phone } = c.req.valid('json');
  const result = await signinRoute(phone);
  if (!result) return c.json({ data: { next: 'unregistered' as const } });
  if (result.hasPassword) return c.json({ data: { next: 'password' as const } });
  return c.json({ data: { next: 'device' as const } });
});

/** Older clients must upgrade; no endpoint sends authentication through an external messaging service. */
const lockerRequired = publicController.createHandlers(async () => {
  throw new AppError(
    'DEVICE_AUTH_UNAVAILABLE',
    410,
    'Verify with your enrolled Qist Locker or sign in with your password.',
  );
});
export const requestCode = lockerRequired;
export const requestReset = lockerRequired;
export const verifyCode = lockerRequired;
export const resetPassword = lockerRequired;

export const setPassword = publicController.createHandlers(
  validate('json', customerSetPasswordSchema),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const { phone, password, setupToken } = c.req.valid('json');
    const digest = setupDigest(phone, setupToken);
    // Reject expired/random proofs before expensive password hashing; the write below also enforces single use.
    const account = await CustomerAccount.findOne({
      phone,
      'setup.digest': digest,
      'setup.expiresAt': { $gt: new Date() },
    })
      .select('+tokenVersion +setup +passwordHash')
      .lean();
    if (!account || !account.setup?.deviceBinding || account.passwordHash)
      throw new ValidationError(
        'Verification expired. Sign in again on your enrolled phone or request a new code.',
      );
    if (account.setup?.deviceBinding && account.setup.deviceBinding.accountVersion !== account.tokenVersion)
      throw new UnauthorizedError('Device sign-in is no longer valid.');
    const passwordHash = await hashPassword(password);
    if (account.setup?.deviceBinding)
      await validateSigninHandoff({
        ...account.setup.deviceBinding,
        phone,
        accountId: account._id,
        accountVersion: account.setup.deviceBinding.accountVersion,
      });
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MS);
    const updated = await CustomerAccount.findOneAndUpdate(
      {
        _id: account._id,
        tokenVersion: account.tokenVersion,
        'setup.digest': digest,
        'setup.expiresAt': { $gt: new Date() },
      },
      {
        $set: { passwordHash, sessions: [{ id, expiresAt }] },
        $unset: { reset: 1, setup: 1 },
        $inc: { tokenVersion: 1 },
      },
      { returnDocument: 'after' },
    )
      .select('+tokenVersion')
      .lean();
    if (!updated)
      throw new ValidationError('Verification expired. Verify again with your enrolled Qist Locker.');
    return c.json({
      data: {
        accessToken: await signCustomerToken(
          { sub: String(updated._id), ver: updated.tokenVersion, sid: id },
          expiresAt,
        ),
        expiresAt: expiresAt.toISOString(),
      },
    });
  },
);

/** Exchange a one-use proof created by the enrolled locker into a customer session or first-password proof. */
export const exchangeDeviceHandoff = publicController.createHandlers(
  validate('json', customerDeviceAuthExchangeSchema),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const { ticket, nonce } = c.req.valid('json');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const now = new Date();

    const handoff = await CustomerAuthHandoff.findOneAndUpdate(
      { ticketHash: hash(ticket), nonceHash: hash(nonce), expiresAt: { $gt: now }, consumedAt: null },
      { $set: { consumedAt: now } },
      { returnDocument: 'after' },
    )
      .select('+enrollmentHash')
      .lean();
    if (!handoff) throw new UnauthorizedError('This device sign-in request has expired. Please try again.');

    await validateSigninHandoff(handoff);
    // The atomic account writes below also retain this identity/version, including after a concurrent deletion.
    const account = await CustomerAccount.findOne({
      _id: handoff.accountId,
      phone: handoff.phone,
      tokenVersion: handoff.accountVersion,
    })
      .select('+passwordHash +tokenVersion')
      .lean();
    if (!account) throw new UnauthorizedError('Please try signing in again.');

    if (account.passwordHash) {
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MS);
      const updated = await CustomerAccount.findOneAndUpdate(
        { _id: account._id, tokenVersion: account.tokenVersion, passwordHash: account.passwordHash },
        { $push: { sessions: { $each: [{ id, expiresAt }], $slice: -5 } } },
        { returnDocument: 'after' },
      )
        .select('_id +tokenVersion')
        .lean();
      if (!updated) throw new UnauthorizedError('Please try signing in again.');
      return c.json({
        data: {
          next: 'session' as const,
          accessToken: await signCustomerToken(
            { sub: String(updated._id), ver: updated.tokenVersion, sid: id },
            expiresAt,
          ),
          expiresAt: expiresAt.toISOString(),
        },
      });
    }

    const setupToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_TTL);
    const updated = await CustomerAccount.findOneAndUpdate(
      { _id: account._id, tokenVersion: account.tokenVersion, passwordHash: null },
      {
        $set: {
          setup: {
            digest: setupDigest(handoff.phone, setupToken),
            expiresAt,
            deviceBinding: {
              accountVersion: account.tokenVersion,
              deviceId: handoff.deviceId,
              orgId: handoff.orgId,
              enrollmentHash: handoff.enrollmentHash,
              keyId: handoff.keyId,
            },
          },
        },
        $unset: { reset: 1 },
      },
      { returnDocument: 'after' },
    )
      .select('_id')
      .lean();
    if (!updated) throw new UnauthorizedError('Please try signing in again.');

    return c.json({
      data: {
        next: 'password' as const,
        phone: handoff.phone,
        setupToken,
        expiresAt: expiresAt.toISOString(),
      },
    });
  },
);

export const overview = customerAppController.createHandlers(
  validate('query', customerOverviewQuerySchema),
  async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ data: await loadCustomerOverview(c.var.customer, c.req.valid('query').contractId) });
  },
);
export const payments = customerAppController.createHandlers(
  validate('query', customerPaymentsQuerySchema),
  async (c) => {
    const { contractId, cursor } = c.req.valid('query');
    c.header('Cache-Control', 'no-store');
    return c.json({ data: await loadCustomerPayments(c.var.customer, contractId, cursor) });
  },
);
export const logout = customerAppController.createHandlers(async (c) => {
  const { sub, ver, sid } = c.var.customer;
  await CustomerAccount.updateOne(
    { _id: new Types.ObjectId(sub), tokenVersion: ver },
    { $pull: { sessions: { id: sid } } },
  );
  await CustomerPushToken.deleteMany({ accountId: new Types.ObjectId(sub), sessionId: sid });
  return c.json({ data: { ok: true } });
});

/** Delete only this verified app identity. Retailer-owned purchase/payment/device records are retained. */
export const deleteAccount = customerAppController.createHandlers(async (c) => {
  c.header('Cache-Control', 'no-store');
  const { sub, ver, sid } = c.var.customer;
  const id = new Types.ObjectId(sub);
  const result = await CustomerAccount.deleteOne({
    _id: id,
    tokenVersion: ver,
    sessions: { $elemMatch: { id: sid, expiresAt: { $gt: new Date() } } },
  });
  // A lost response can safely be retried with the same still-signed token; never remove a recreated identity.
  if (result.deletedCount === 0 && (await CustomerAccount.exists({ _id: id }))) throw new UnauthorizedError();
  await Promise.all([
    CustomerPushToken.deleteMany({ accountId: id }),
    CustomerNotification.deleteMany({ accountId: id }),
  ]);
  return c.json({ data: { ok: true } });
});

async function activeCustomer(claims: { sub: string; ver: number; sid: string }) {
  const account = await CustomerAccount.findOne({
    _id: new Types.ObjectId(claims.sub),
    tokenVersion: claims.ver,
    sessions: { $elemMatch: { id: claims.sid, expiresAt: { $gt: new Date() } } },
  })
    .select('+sessions')
    .lean();
  if (!account) throw new UnauthorizedError();
  return account;
}
export const registerPush = customerAppController.createHandlers(
  validate('json', customerPushSchema),
  async (c) => {
    const account = await activeCustomer(c.var.customer);
    const { token } = c.req.valid('json');
    const hash = createHash('sha256').update(token).digest('hex');
    await CustomerPushToken.deleteMany({
      accountId: account._id,
      sessionId: c.var.customer.sid,
      _id: { $ne: hash },
    });
    await CustomerPushToken.updateOne(
      { _id: hash },
      {
        $set: {
          accountId: account._id,
          sessionId: c.var.customer.sid,
          token,
          expiresAt: account.sessions.find((s) => s.id === c.var.customer.sid)!.expiresAt,
        },
      },
      { upsert: true },
    );
    return c.json({ data: { ok: true } });
  },
);
export const unregisterPush = customerAppController.createHandlers(async (c) => {
  await activeCustomer(c.var.customer);
  await CustomerPushToken.deleteMany({
    accountId: new Types.ObjectId(c.var.customer.sub),
    sessionId: c.var.customer.sid,
  });
  return c.json({ data: { ok: true } });
});
export const readNotifications = customerAppController.createHandlers(
  validate('json', customerReadNotificationsSchema),
  async (c) => {
    await activeCustomer(c.var.customer);
    await CustomerNotification.updateMany(
      {
        accountId: new Types.ObjectId(c.var.customer.sub),
        _id: { $in: c.req.valid('json').ids.map((id) => new Types.ObjectId(id)) },
        readAt: null,
      },
      { $set: { readAt: new Date() } },
    );
    return c.json({ data: { ok: true } });
  },
);
