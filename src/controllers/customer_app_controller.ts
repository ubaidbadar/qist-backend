import { createHash, createHmac, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import { customerLoginSchema, customerOverviewQuerySchema, customerPaymentsQuerySchema, customerRecoverySchema, customerCodeRequestSchema, customerDeviceAuthExchangeSchema, customerResetSchema, customerVerifyCodeSchema, customerSetPasswordSchema, customerPushSchema, customerReadNotificationsSchema } from '@shop/shared';
import { mongo, Types } from 'mongoose';
import { env } from '../config/env';
import { loadCustomerOverview, loadCustomerPayments } from '../lib/customer_data';
import { CUSTOMER_SESSION_MS, signCustomerToken } from '../lib/customer_session';
import { AppError, UnauthorizedError, ValidationError, RateLimitError } from '../lib/errors';
import { customerAppController, publicController } from '../lib/factory';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../lib/passwords';
import { validate } from '../lib/validate';
import { requireWhatsApp, sendWhatsAppCode } from '../lib/whatsapp';
import { Customer } from '../models/customer';
import { CustomerNotification } from '../models/customer_notification';
import { CustomerPushToken } from '../models/customer_push_token';
import { CustomerAccount } from '../models/customer_account';
import { validateSigninHandoff } from '../lib/trusted_device_auth';
import { CustomerAuthHandoff } from '../models/customer_auth_handoff';

const HOUR = 60 * 60 * 1000;
const RESET_TTL = 5 * 60 * 1000;
const resetDigest = (phone: string, code: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(`customer-reset:${phone}:${code}`).digest('hex');
const setupDigest = (phone: string, token: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(`customer-setup:${phone}:${token}`).digest('hex');
const genericRecovery = { ok: true, message: 'If your retailer registered this number, a code will arrive on WhatsApp. Wait one minute before requesting another.' };

/** Password verification requires a read, then a conditional atomic write; no user/retailer refetch. */
export const login = publicController.createHandlers(validate('json', customerLoginSchema), async (c) => {
  const { phone, password } = c.req.valid('json');
  const account = await CustomerAccount.findOne({ phone }).select('+passwordHash +tokenVersion').lean();
  const valid = account?.passwordHash ? await verifyPassword(password, account.passwordHash) : await verifyAgainstDummy(password);
  if (!account || !valid) throw new UnauthorizedError('Phone number or password is incorrect');
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MS);
  const updated = await CustomerAccount.findOneAndUpdate(
    { _id: account._id, tokenVersion: account.tokenVersion, passwordHash: account.passwordHash },
    { $push: { sessions: { $each: [{ id, expiresAt }], $slice: -5 } } },
    { returnDocument: 'after' },
  ).select('_id +tokenVersion').lean();
  if (!updated) throw new UnauthorizedError('Please try signing in again');
  const accessToken = await signCustomerToken({ sub: String(updated._id), ver: updated.tokenVersion, sid: id }, expiresAt);
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { accessToken, expiresAt: expiresAt.toISOString() } });
});

/** Exact-phone eligibility lookup; never returns customer, retailer or contract details. */
async function registeredPhone(phone: string, requirePlan = false) {
  const rows = await Customer.aggregate([
    { $match: { orgId: { $exists: true }, phone } },
    { $lookup: { from: 'orgs', localField: 'orgId', foreignField: '_id', pipeline: [{ $match: { status: 'active' } }, { $project: { _id: 1 } }], as: 'org' } },
    { $match: { 'org.0': { $exists: true } } },
    ...(requirePlan ? [
      {
        $lookup: {
          from: 'contracts', let: { customer: '$_id', org: '$orgId' }, pipeline: [
            { $match: { status: { $in: ['active', 'defaulted', 'completed'] }, $expr: { $and: [{ $eq: ['$customerId', '$$customer'] }, { $eq: ['$orgId', '$$org'] }] } } },
            { $limit: 1 }, { $project: { _id: 1 } },
          ], as: 'plans'
        }
      }, { $match: { 'plans.0': { $exists: true } } },
    ] : []),
    { $limit: 1 }, { $project: { _id: 1 } },
  ]);
  return rows.length > 0;
}

/** Shared delivery/cooldown boundary for first setup and recovery. No blind resend retries. */
async function issueCode(phone: string, strict: boolean, channel: 'auto' | 'device' | 'whatsapp' = 'auto') {
  // Old clients keep their WhatsApp recovery flow; approval uses the signed challenge endpoints.
  if (channel === 'device') throw new AppError('DEVICE_AUTH_UNAVAILABLE', 503, 'Update Qist to use secure device approval, or use WhatsApp recovery.');
  requireWhatsApp();

  const now = new Date();
  const hourAgo = new Date(now.getTime() - HOUR);
  const code = randomInt(1_000_000).toString().padStart(6, '0');
  const digest = resetDigest(phone, code);
  const requestId = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + RESET_TTL);
  const expiredWindow = { $lte: [{ $ifNull: ['$resetWindowStart', new Date(0)] }, hourAgo] };
  try {
    await CustomerAccount.findOneAndUpdate({
      phone, $and: [
        { $or: [{ lastResetSentAt: { $lte: new Date(now.getTime() - 60_000) } }, { lastResetSentAt: null }] },
        { $or: [{ 'reset.attempts': { $lt: 5 } }, { 'reset.expiresAt': { $lte: now } }, { reset: null }] },
        { $or: [{ resetWindowStart: { $lte: hourAgo } }, { resetWindowStart: null }, { resetSentCount: { $lt: 5 } }] },
      ]
    }, [{
      $set: {
        phone: { $literal: phone }, reset: { $literal: { digest, sentAt: now, expiresAt, attempts: 0, requestId } },
        setup: '$$REMOVE', lastResetSentAt: now,
        resetWindowStart: { $cond: [expiredWindow, now, '$resetWindowStart'] },
        resetSentCount: { $cond: [expiredWindow, 1, { $add: [{ $ifNull: ['$resetSentCount', 0] }, 1] }] },
        tokenVersion: { $ifNull: ['$tokenVersion', 0] }, sessions: { $ifNull: ['$sessions', []] },
        createdAt: { $ifNull: ['$createdAt', now] }, updatedAt: now,
      }
    }], { upsert: true, updatePipeline: true }).select('+reset').lean();
  } catch (err) {
    if (!(err instanceof mongo.MongoServerError && err.code === 11000)) throw err;
    if (!strict) return { retryAfterSeconds: 60, delivery: 'whatsapp' as const };
    const account = await CustomerAccount.findOne({ phone }).select('+reset +lastResetSentAt +resetWindowStart +resetSentCount').lean();
    if (account?.reset && account.reset.expiresAt > now && account.reset.attempts >= 5) throw verificationLimit(account.reset.expiresAt, now);
    const cooldown = Math.max(1, Math.ceil(((account?.lastResetSentAt?.getTime() ?? now.getTime()) + 60_000 - now.getTime()) / 1000));
    const hourly = account && account.resetSentCount >= 5 && account.resetWindowStart
      ? Math.max(0, Math.ceil((account.resetWindowStart.getTime() + HOUR - now.getTime()) / 1000)) : 0;
    if (account?.reset && account.reset.expiresAt > now && account.reset.attempts < 5) {
      return { retryAfterSeconds: Math.max(cooldown, hourly), delivery: 'whatsapp' as const };
    }
    throw new RateLimitError(Math.max(cooldown, hourly));
  }

  try {
    await sendWhatsAppCode(phone, code);
    return { retryAfterSeconds: 60, delivery: 'whatsapp' as const };
  } catch (err) {
    await CustomerAccount.updateOne({ phone, 'reset.digest': digest }, { $set: { 'reset.expiresAt': now } });
    throw err;
  }
}

export const start = publicController.createHandlers(validate('json', customerRecoverySchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { phone } = c.req.valid('json');
  if (!await registeredPhone(phone, true)) return c.json({ data: { next: 'unregistered' as const } });
  const account = await CustomerAccount.findOne({ phone }).select('+passwordHash').lean();
  if (account?.passwordHash) return c.json({ data: { next: 'password' as const } });
  const issued = await issueCode(phone, true);
  return c.json({ data: { next: 'otp' as const, ...issued } });
});

export const requestCode = publicController.createHandlers(validate('json', customerCodeRequestSchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { phone, channel } = c.req.valid('json');
  if (!await registeredPhone(phone, true)) throw new ValidationError('No plan is linked to this number. Contact your retailer.');
  return c.json({ data: await issueCode(phone, true, channel) });
});

export const requestReset = publicController.createHandlers(validate('json', customerRecoverySchema), async (c) => {
  requireWhatsApp();
  const { phone } = c.req.valid('json');
  if (await registeredPhone(phone)) await issueCode(phone, false);
  c.header('Cache-Control', 'no-store');
  return c.json({ data: genericRecovery });
});

function verificationLimit(expiresAt: Date, now: Date) {
  const seconds = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
  return new RateLimitError(seconds, 'OTP_ATTEMPTS_EXCEEDED', 'Too many verification attempts. Please wait before requesting a new code.');
}

export const verifyCode = publicController.createHandlers(validate('json', customerVerifyCodeSchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { phone, code } = c.req.valid('json');
  const now = new Date();
  const invalid = () => new AppError('OTP_CODE_EXPIRED', 400, 'The code has expired. Request a new code.');
  const account = await CustomerAccount.findOneAndUpdate(
    { phone, 'reset.expiresAt': { $gt: now }, 'reset.attempts': { $lt: 5 } },
    { $inc: { 'reset.attempts': 1 } }, { returnDocument: 'before' },
  ).select('+reset +tokenVersion').lean();
  if (!account?.reset) {
    const current = await CustomerAccount.findOne({ phone }).select('+reset').lean();
    if (current?.reset && current.reset.expiresAt > now && current.reset.attempts >= 5) throw verificationLimit(current.reset.expiresAt, now);
    throw invalid();
  }
  const expected = Buffer.from(account.reset.digest, 'hex');
  const actual = Buffer.from(resetDigest(phone, code), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    if (account.reset.attempts >= 4) throw verificationLimit(account.reset.expiresAt, now);
    throw new AppError('OTP_CODE_INVALID', 400, 'That code is incorrect. Please try again.');
  }
  const setupToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + RESET_TTL);
  const result = await CustomerAccount.updateOne(
    { _id: account._id, tokenVersion: account.tokenVersion, 'reset.digest': account.reset.digest, 'reset.expiresAt': { $gt: new Date() }, 'reset.attempts': { $lte: 5 } },
    { $set: { setup: { digest: setupDigest(phone, setupToken), expiresAt } }, $unset: { reset: 1 } },
  );
  if (result.modifiedCount !== 1) throw invalid();
  return c.json({ data: { setupToken, expiresAt: expiresAt.toISOString() } });
});

export const setPassword = publicController.createHandlers(validate('json', customerSetPasswordSchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { phone, password, setupToken } = c.req.valid('json');
  const digest = setupDigest(phone, setupToken);
  // Reject expired/random proofs before expensive password hashing; the write below also enforces single use.
  const account = await CustomerAccount.findOne({ phone, 'setup.digest': digest, 'setup.expiresAt': { $gt: new Date() } }).select('+tokenVersion +setup').lean();
  if (!account) throw new ValidationError('Verification expired. Sign in again on your enrolled phone or request a new code.');
  const passwordHash = await hashPassword(password);
  if (account.setup?.deviceBinding) await validateSigninHandoff({ ...account.setup.deviceBinding, phone, accountId: account._id, accountVersion: account.setup.deviceBinding.accountVersion });
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MS);
  const updated = await CustomerAccount.findOneAndUpdate(
    { _id: account._id, tokenVersion: account.tokenVersion, 'setup.digest': digest, 'setup.expiresAt': { $gt: new Date() } },
    { $set: { passwordHash, sessions: [{ id, expiresAt }] }, $unset: { reset: 1, setup: 1 }, $inc: { tokenVersion: 1 } },
    { returnDocument: 'after' },
  ).select('+tokenVersion').lean();
  if (!updated) throw new ValidationError('Verification expired. Request a new WhatsApp code.');
  return c.json({ data: { accessToken: await signCustomerToken({ sub: String(updated._id), ver: updated.tokenVersion, sid: id }, expiresAt), expiresAt: expiresAt.toISOString() } });
});

export const resetPassword = publicController.createHandlers(validate('json', customerResetSchema), async (c) => {
  const { phone, password, code } = c.req.valid('json');
  const now = new Date();
  const invalid = () => new ValidationError('The code is invalid or expired. Request a new WhatsApp code.');
  // Each attempted code consumes one of five guesses, even when requests race.
  const account = await CustomerAccount.findOneAndUpdate(
    { phone, 'reset.expiresAt': { $gt: now }, 'reset.attempts': { $lt: 5 } },
    { $inc: { 'reset.attempts': 1 } }, { returnDocument: 'before' },
  ).select('+reset +tokenVersion').lean();
  if (!account?.reset) throw invalid();
  const expected = Buffer.from(account.reset.digest, 'hex');
  const actual = Buffer.from(resetDigest(phone, code), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();
  const passwordHash = await hashPassword(password);
  const updated = await CustomerAccount.updateOne(
    { _id: account._id, tokenVersion: account.tokenVersion, 'reset.digest': account.reset.digest, 'reset.expiresAt': { $gt: new Date() }, 'reset.attempts': { $lte: 5 } },
    { $set: { passwordHash, sessions: [] }, $unset: { reset: 1, setup: 1 }, $inc: { tokenVersion: 1 } },
  );
  if (updated.modifiedCount !== 1) throw invalid();
  return c.json({ data: { ok: true } });
});

/** Exchange a one-use proof created by the enrolled locker into a customer session or first-password proof. */
export const exchangeDeviceHandoff = publicController.createHandlers(validate('json', customerDeviceAuthExchangeSchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { ticket, nonce } = c.req.valid('json');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const now = new Date();

  const handoff = await CustomerAuthHandoff.findOneAndUpdate(
    { ticketHash: hash(ticket), nonceHash: hash(nonce), expiresAt: { $gt: now }, consumedAt: null },
    { $set: { consumedAt: now } },
    { returnDocument: 'after' },
  ).select('+enrollmentHash').lean();
  if (!handoff) throw new UnauthorizedError('This device sign-in request has expired. Please try again.');

  await validateSigninHandoff(handoff);
  // The atomic account writes below also retain this identity/version, including after a concurrent deletion.
  const account = await CustomerAccount.findOne({ _id: handoff.accountId, phone: handoff.phone, tokenVersion: handoff.accountVersion }).select('+passwordHash +tokenVersion').lean();
  if (!account) throw new UnauthorizedError('Please try signing in again.');

  if (account.passwordHash) {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_MS);
    const updated = await CustomerAccount.findOneAndUpdate(
      { _id: account._id, tokenVersion: account.tokenVersion, passwordHash: account.passwordHash },
      { $push: { sessions: { $each: [{ id, expiresAt }], $slice: -5 } } },
      { returnDocument: 'after' },
    ).select('_id +tokenVersion').lean();
    if (!updated) throw new UnauthorizedError('Please try signing in again.');
    return c.json({
      data: {
        next: 'session' as const,
        accessToken: await signCustomerToken({ sub: String(updated._id), ver: updated.tokenVersion, sid: id }, expiresAt),
        expiresAt: expiresAt.toISOString(),
      },
    });
  }

  const setupToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TTL);
  const updated = await CustomerAccount.findOneAndUpdate(
    { _id: account._id, tokenVersion: account.tokenVersion, passwordHash: null },
    { $set: { setup: { digest: setupDigest(handoff.phone, setupToken), expiresAt, deviceBinding: { accountVersion: account.tokenVersion, deviceId: handoff.deviceId, orgId: handoff.orgId, enrollmentHash: handoff.enrollmentHash, keyId: handoff.keyId } } }, $unset: { reset: 1 } },
    { returnDocument: 'after' },
  ).select('_id').lean();
  if (!updated) throw new UnauthorizedError('Please try signing in again.');

  return c.json({ data: { next: 'password' as const, phone: handoff.phone, setupToken, expiresAt: expiresAt.toISOString() } });
});

export const overview = customerAppController.createHandlers(validate('query', customerOverviewQuerySchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ data: await loadCustomerOverview(c.var.customer, c.req.valid('query').contractId) });
});
export const payments = customerAppController.createHandlers(validate('query', customerPaymentsQuerySchema), async (c) => {
  const { contractId, cursor } = c.req.valid('query');
  c.header('Cache-Control', 'no-store');
  return c.json({ data: await loadCustomerPayments(c.var.customer, contractId, cursor) });
});
export const logout = customerAppController.createHandlers(async (c) => {
  const { sub, ver, sid } = c.var.customer;
  await CustomerAccount.updateOne({ _id: new Types.ObjectId(sub), tokenVersion: ver }, { $pull: { sessions: { id: sid } } });
  await CustomerPushToken.deleteMany({ accountId: new Types.ObjectId(sub), sessionId: sid });
  return c.json({ data: { ok: true } });
});

/** Delete only this verified app identity. Retailer-owned purchase/payment/device records are retained. */
export const deleteAccount = customerAppController.createHandlers(async (c) => {
  c.header('Cache-Control', 'no-store');
  const { sub, ver, sid } = c.var.customer;
  const id = new Types.ObjectId(sub);
  const result = await CustomerAccount.deleteOne({
    _id: id, tokenVersion: ver, sessions: { $elemMatch: { id: sid, expiresAt: { $gt: new Date() } } },
  });
  // A lost response can safely be retried with the same still-signed token; never remove a recreated identity.
  if (result.deletedCount === 0 && await CustomerAccount.exists({ _id: id })) throw new UnauthorizedError();
  await Promise.all([CustomerPushToken.deleteMany({ accountId: id }), CustomerNotification.deleteMany({ accountId: id })]);
  return c.json({ data: { ok: true } });
});

async function activeCustomer(claims: { sub: string; ver: number; sid: string }) {
  const account = await CustomerAccount.findOne({
    _id: new Types.ObjectId(claims.sub), tokenVersion: claims.ver,
    sessions: { $elemMatch: { id: claims.sid, expiresAt: { $gt: new Date() } } }
  }).select('+sessions').lean();
  if (!account) throw new UnauthorizedError();
  return account;
}
export const registerPush = customerAppController.createHandlers(validate('json', customerPushSchema), async (c) => {
  const account = await activeCustomer(c.var.customer);
  const { token } = c.req.valid('json');
  const hash = createHash('sha256').update(token).digest('hex');
  await CustomerPushToken.deleteMany({ accountId: account._id, sessionId: c.var.customer.sid, _id: { $ne: hash } });
  await CustomerPushToken.updateOne({ _id: hash }, {
    $set: {
      accountId: account._id, sessionId: c.var.customer.sid, token,
      expiresAt: account.sessions.find((s) => s.id === c.var.customer.sid)!.expiresAt,
    }
  }, { upsert: true });
  return c.json({ data: { ok: true } });
});
export const unregisterPush = customerAppController.createHandlers(async (c) => {
  await activeCustomer(c.var.customer);
  await CustomerPushToken.deleteMany({ accountId: new Types.ObjectId(c.var.customer.sub), sessionId: c.var.customer.sid });
  return c.json({ data: { ok: true } });
});
export const readNotifications = customerAppController.createHandlers(validate('json', customerReadNotificationsSchema), async (c) => {
  await activeCustomer(c.var.customer);
  await CustomerNotification.updateMany({ accountId: new Types.ObjectId(c.var.customer.sub), _id: { $in: c.req.valid('json').ids.map((id) => new Types.ObjectId(id)) }, readAt: null }, { $set: { readAt: new Date() } });
  return c.json({ data: { ok: true } });
});
