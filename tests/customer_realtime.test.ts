import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../src/config/env';
import { signCustomerToken } from '../src/lib/customer_session';
import { CustomerAccount } from '../src/models/customer_account';
import { CustomerPushToken } from '../src/models/customer_push_token';
import { CustomerNotification } from '../src/models/customer_notification';
import { deliverCustomerNotifications } from '../src/lib/customer_notifications';
import * as push from '../src/lib/push';
import { call } from './api';

const phone = '03001234567';
const claims = { sub: new Types.ObjectId().toHexString(), ver: 1, sid: crypto.randomUUID() };
const expiry = new Date(Date.now() + 240_000);
const chain = (value: unknown) => ({ select: () => ({ lean: async () => value }) });
const mocks: { mockRestore(): void }[] = [];
afterEach(() => { mocks.forEach((m) => m.mockRestore()); mocks.length = 0; });
function active(value: unknown = { _id: new Types.ObjectId(claims.sub), sessions: [{ id: claims.sid, expiresAt: expiry }] }) {
  const mock = spyOn(CustomerAccount, 'findOne').mockReturnValue(chain(value) as unknown as ReturnType<typeof CustomerAccount.findOne>); mocks.push(mock);
}
async function token() { return signCustomerToken(claims, expiry); }

test('push token and inbox read endpoints require customer authentication', async () => {
  for (const [method, path, body] of [
    ['POST', '/customer-app/push-token', { token: 'a'.repeat(60) }],
    ['DELETE', '/customer-app/push-token', undefined],
    ['POST', '/customer-app/notifications/read', { ids: [new Types.ObjectId().toHexString()] }],
  ] as const) expect((await call(method, path, { body })).status).toBe(401);
});
test('registration binds an installation token to the current verified account and session', async () => {
  active();
  const removal = spyOn(CustomerPushToken, 'deleteMany').mockResolvedValue({ acknowledged: true, deletedCount: 0 }); mocks.push(removal);
  const write = spyOn(CustomerPushToken, 'updateOne').mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null }); mocks.push(write);
  const result = await call('POST', '/customer-app/push-token', { token: await token(), body: { token: 'a'.repeat(60) } });
  expect(result.status).toBe(200);
  const args = write.mock.calls[0] as unknown as [{ _id: string }, { $set: { accountId: Types.ObjectId; sessionId: string; expiresAt: Date } }];
  expect(args[0]._id).toHaveLength(64); expect(String(args[1].$set.accountId)).toBe(claims.sub); expect(args[1].$set.sessionId).toBe(claims.sid);
});
test('revoked sessions cannot register for notifications', async () => {
  active(null);
  expect((await call('POST', '/customer-app/push-token', { token: await token(), body: { token: 'a'.repeat(60) } })).status).toBe(401);
});
test('mark read always scopes supplied IDs to the signed in account', async () => {
  active(); const id = new Types.ObjectId();
  const write = spyOn(CustomerNotification, 'updateMany').mockResolvedValue({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }); mocks.push(write);
  expect((await call('POST', '/customer-app/notifications/read', { token: await token(), body: { ids: [String(id)] } })).status).toBe(200);
  const filter = write.mock.calls[0]![0] as unknown as { accountId: Types.ObjectId; _id: { $in: Types.ObjectId[] } };
  expect(String(filter.accountId)).toBe(claims.sub); expect(String(filter._id.$in[0])).toBe(String(id));
});
function challenge(attempts: number) {
  return { _id: new Types.ObjectId(claims.sub), tokenVersion: 1, reset: { attempts, expiresAt: expiry,
    digest: createHmac('sha256', env.JWT_REFRESH_SECRET).update(`customer-reset:${phone}:123456`).digest('hex') } };
}
test('incorrect OTP has a distinct error without creating an authenticated session', async () => {
  const mock = spyOn(CustomerAccount, 'findOneAndUpdate').mockReturnValue(chain(challenge(0)) as unknown as ReturnType<typeof CustomerAccount.findOneAndUpdate>); mocks.push(mock);
  const result = await call('POST', '/customer-app/auth/verify-code', { body: { phone, code: '000000' } });
  expect(result.status).toBe(400); expect(result.error?.code).toBe('OTP_CODE_INVALID');
});
test('fifth incorrect OTP reports the remaining server cooldown', async () => {
  const mock = spyOn(CustomerAccount, 'findOneAndUpdate').mockReturnValue(chain(challenge(4)) as unknown as ReturnType<typeof CustomerAccount.findOneAndUpdate>); mocks.push(mock);
  const result = await call('POST', '/customer-app/auth/verify-code', { body: { phone, code: '000000' } });
  expect(result.status).toBe(429); expect(result.error?.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  const details = result.error?.details as { retryAfterSeconds: number };
  expect(details.retryAfterSeconds).toBeGreaterThan(0); expect(details.retryAfterSeconds).toBeLessThanOrEqual(240);
});
test('exhausted challenge rejects a correct code until expiry', async () => {
  const mock = spyOn(CustomerAccount, 'findOneAndUpdate').mockReturnValue(chain(null) as unknown as ReturnType<typeof CustomerAccount.findOneAndUpdate>); mocks.push(mock);
  active(challenge(5));
  const result = await call('POST', '/customer-app/auth/verify-code', { body: { phone, code: '123456' } });
  expect(result.status).toBe(429); expect(result.error?.code).toBe('OTP_ATTEMPTS_EXCEEDED');
});

for (const outcome of ['gone', 'retry'] as const) test(`durable delivery handles ${outcome} without exposing account content to FCM`, async () => {
  const event = { _id: new Types.ObjectId(), accountId: new Types.ObjectId(claims.sub), attempts: 1 };
  let first = true;
  const claim = spyOn(CustomerNotification, 'findOneAndUpdate').mockReturnValue({ lean: async () => {
    if (!first) return null; first = false; return event;
  } } as unknown as ReturnType<typeof CustomerNotification.findOneAndUpdate>); mocks.push(claim);
  const account = spyOn(CustomerAccount, 'findById').mockReturnValue(chain({ sessions: [{ id: claims.sid, expiresAt: expiry }] }) as unknown as ReturnType<typeof CustomerAccount.findById>); mocks.push(account);
  const tokens = spyOn(CustomerPushToken, 'find').mockReturnValue(chain([{ _id: 'token-hash', token: 'fcm-token' }]) as unknown as ReturnType<typeof CustomerPushToken.find>); mocks.push(tokens);
  const send = spyOn(push, 'sendCustomerPush').mockResolvedValue(outcome); mocks.push(send);
  const removal = spyOn(CustomerPushToken, 'deleteOne').mockResolvedValue({ acknowledged: true, deletedCount: 1 }); mocks.push(removal);
  const write = spyOn(CustomerNotification, 'updateOne').mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null }); mocks.push(write);
  await deliverCustomerNotifications();
  expect(send).toHaveBeenCalledWith('fcm-token', String(event._id));
  const values = write.mock.calls[0]![1] as unknown as { $set: { deliveredAt?: Date; nextAttemptAt?: Date } };
  if (outcome === 'gone') { expect(removal).toHaveBeenCalledTimes(1); expect(values.$set.deliveredAt).toBeInstanceOf(Date); }
  else { expect(removal).not.toHaveBeenCalled(); expect(values.$set.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now()); }
});
