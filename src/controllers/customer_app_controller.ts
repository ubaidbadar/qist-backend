import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { customerLoginSchema, customerOverviewQuerySchema, customerPaymentsQuerySchema, customerRecoverySchema, customerResetSchema } from '@shop/shared';
import { mongo, Types } from 'mongoose';
import { env } from '../config/env';
import { loadCustomerOverview, loadCustomerPayments } from '../lib/customer_data';
import { CUSTOMER_SESSION_MS, signCustomerToken } from '../lib/customer_session';
import { UnauthorizedError, ValidationError } from '../lib/errors';
import { customerAppController, publicController } from '../lib/factory';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../lib/passwords';
import { validate } from '../lib/validate';
import { requireWhatsApp, sendWhatsAppCode } from '../lib/whatsapp';
import { Customer } from '../models/customer';
import { CustomerAccount } from '../models/customer_account';

const HOUR = 60 * 60 * 1000;
const RESET_TTL = 5 * 60 * 1000;
const resetDigest = (phone: string, code: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(`customer-reset:${phone}:${code}`).digest('hex');
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

/** Only a phone already registered with an active retailer can claim a customer identity. */
export const requestReset = publicController.createHandlers(validate('json', customerRecoverySchema), async (c) => {
  requireWhatsApp();
  const { phone } = c.req.valid('json');
  // Pre-auth cross-retailer discovery is phone-exact; it returns no customer details.
  const [registered] = await Customer.aggregate([
    { $match: { orgId: { $exists: true }, phone } },
    { $lookup: { from: 'orgs', localField: 'orgId', foreignField: '_id', pipeline: [{ $match: { status: 'active' } }, { $project: { _id: 1 } }], as: 'org' } },
    { $match: { 'org.0': { $exists: true } } }, { $limit: 1 }, { $project: { _id: 1 } },
  ]);
  if (!registered) return c.json({ data: genericRecovery });
  const now = new Date();
  const hourAgo = new Date(now.getTime() - HOUR);
  const code = randomInt(1_000_000).toString().padStart(6, '0');
  const digest = resetDigest(phone, code);
  const expiredWindow = { $lte: [{ $ifNull: ['$resetWindowStart', new Date(0)] }, hourAgo] };
  try {
    // The unique phone index turns simultaneous requests/cooldown races into one successful sender.
    await CustomerAccount.findOneAndUpdate({ phone, $and: [
      { $or: [{ 'reset.sentAt': { $lte: new Date(now.getTime() - 60_000) } }, { 'reset.sentAt': { $exists: false } }] },
      { $or: [{ resetWindowStart: { $lte: hourAgo } }, { resetWindowStart: null }, { resetSentCount: { $lt: 5 } }] },
    ] }, [{ $set: {
      phone: { $literal: phone }, reset: { $literal: { digest, sentAt: now, expiresAt: new Date(now.getTime() + RESET_TTL), attempts: 0 } },
      resetWindowStart: { $cond: [expiredWindow, now, '$resetWindowStart'] },
      resetSentCount: { $cond: [expiredWindow, 1, { $add: [{ $ifNull: ['$resetSentCount', 0] }, 1] }] },
      tokenVersion: { $ifNull: ['$tokenVersion', 0] }, sessions: { $ifNull: ['$sessions', []] },
      createdAt: { $ifNull: ['$createdAt', now] }, updatedAt: now,
    } }], { upsert: true, updatePipeline: true });
  } catch (err) {
    if (err instanceof mongo.MongoServerError && err.code === 11000) return c.json({ data: genericRecovery });
    throw err;
  }
  try { await sendWhatsAppCode(phone, code); }
  catch (err) {
    await CustomerAccount.updateOne({ phone, 'reset.digest': digest }, { $set: { 'reset.expiresAt': now } });
    throw err;
  }
  return c.json({ data: genericRecovery });
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
    { $set: { passwordHash, sessions: [] }, $unset: { reset: 1 }, $inc: { tokenVersion: 1 } },
  );
  if (updated.modifiedCount !== 1) throw invalid();
  return c.json({ data: { ok: true } });
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
  return c.json({ data: { ok: true } });
});
