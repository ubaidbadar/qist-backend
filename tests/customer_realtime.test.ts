import { afterEach, expect, spyOn, test } from 'bun:test';
import { Types } from 'mongoose';
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
afterEach(() => {
  mocks.forEach((m) => m.mockRestore());
  mocks.length = 0;
});
function active(
  value: unknown = { _id: new Types.ObjectId(claims.sub), sessions: [{ id: claims.sid, expiresAt: expiry }] },
) {
  const mock = spyOn(CustomerAccount, 'findOne').mockReturnValue(
    chain(value) as unknown as ReturnType<typeof CustomerAccount.findOne>,
  );
  mocks.push(mock);
}
async function token() {
  return signCustomerToken(claims, expiry);
}

test('push token and inbox read endpoints require customer authentication', async () => {
  for (const [method, path, body] of [
    ['POST', '/customer-app/push-token', { token: 'a'.repeat(60) }],
    ['DELETE', '/customer-app/push-token', undefined],
    ['POST', '/customer-app/notifications/read', { ids: [new Types.ObjectId().toHexString()] }],
  ] as const)
    expect((await call(method, path, { body })).status).toBe(401);
});
test('registration binds an installation token to the current verified account and session', async () => {
  active();
  const removal = spyOn(CustomerPushToken, 'deleteMany').mockResolvedValue({
    acknowledged: true,
    deletedCount: 0,
  });
  mocks.push(removal);
  const write = spyOn(CustomerPushToken, 'updateOne').mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  });
  mocks.push(write);
  const result = await call('POST', '/customer-app/push-token', {
    token: await token(),
    body: { token: 'a'.repeat(60) },
  });
  expect(result.status).toBe(200);
  const args = write.mock.calls[0] as unknown as [
    { _id: string },
    { $set: { accountId: Types.ObjectId; sessionId: string; expiresAt: Date } },
  ];
  expect(args[0]._id).toHaveLength(64);
  expect(String(args[1].$set.accountId)).toBe(claims.sub);
  expect(args[1].$set.sessionId).toBe(claims.sid);
});
test('revoked sessions cannot register for notifications', async () => {
  active(null);
  expect(
    (
      await call('POST', '/customer-app/push-token', {
        token: await token(),
        body: { token: 'a'.repeat(60) },
      })
    ).status,
  ).toBe(401);
});
test('mark read always scopes supplied IDs to the signed in account', async () => {
  active();
  const id = new Types.ObjectId();
  const write = spyOn(CustomerNotification, 'updateMany').mockResolvedValue({
    acknowledged: true,
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 0,
    upsertedId: null,
  });
  mocks.push(write);
  expect(
    (
      await call('POST', '/customer-app/notifications/read', {
        token: await token(),
        body: { ids: [String(id)] },
      })
    ).status,
  ).toBe(200);
  const filter = write.mock.calls[0]![0] as unknown as {
    accountId: Types.ObjectId;
    _id: { $in: Types.ObjectId[] };
  };
  expect(String(filter.accountId)).toBe(claims.sub);
  expect(String(filter._id.$in[0])).toBe(String(id));
});
test('removed message OTP endpoints cannot issue proofs even when old reset state exists', async () => {
  for (const code of ['000000', '123456']) {
    const result = await call('POST', '/customer-app/auth/verify-code', { body: { phone, code } });
    expect(result.status).toBe(410);
    expect(result.data).toBeUndefined();
  }
});

for (const outcome of ['gone', 'retry'] as const)
  test(`durable delivery handles ${outcome} without exposing account content to FCM`, async () => {
    const event = { _id: new Types.ObjectId(), accountId: new Types.ObjectId(claims.sub), attempts: 1 };
    let first = true;
    const claim = spyOn(CustomerNotification, 'findOneAndUpdate').mockReturnValue({
      lean: async () => {
        if (!first) return null;
        first = false;
        return event;
      },
    } as unknown as ReturnType<typeof CustomerNotification.findOneAndUpdate>);
    mocks.push(claim);
    const account = spyOn(CustomerAccount, 'findById').mockReturnValue(
      chain({ sessions: [{ id: claims.sid, expiresAt: expiry }] }) as unknown as ReturnType<
        typeof CustomerAccount.findById
      >,
    );
    mocks.push(account);
    const tokens = spyOn(CustomerPushToken, 'find').mockReturnValue(
      chain([{ _id: 'token-hash', token: 'fcm-token' }]) as unknown as ReturnType<
        typeof CustomerPushToken.find
      >,
    );
    mocks.push(tokens);
    const send = spyOn(push, 'sendCustomerPush').mockResolvedValue({
      result: outcome,
      retryAfterSeconds: outcome === 'retry' ? 3600 : 0,
    });
    mocks.push(send);
    const removal = spyOn(CustomerPushToken, 'deleteOne').mockResolvedValue({
      acknowledged: true,
      deletedCount: 1,
    });
    mocks.push(removal);
    const write = spyOn(CustomerNotification, 'updateOne').mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    });
    mocks.push(write);
    await deliverCustomerNotifications();
    expect(send).toHaveBeenCalledWith('fcm-token', String(event._id));
    const values = write.mock.calls[0]![1] as unknown as {
      $set: { deliveredAt?: Date; nextAttemptAt?: Date };
    };
    if (outcome === 'gone') {
      expect(removal).toHaveBeenCalledTimes(1);
      expect(values.$set.deliveredAt).toBeInstanceOf(Date);
    } else {
      expect(removal).not.toHaveBeenCalled();
      expect(values.$set.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + 3_599_000);
    }
  });

test('delivery retry excludes registrations already delivered successfully', async () => {
  const event = {
    _id: new Types.ObjectId(),
    accountId: new Types.ObjectId(claims.sub),
    attempts: 2,
    deliveredTokens: ['already-sent'],
  };
  let first = true;
  const claim = spyOn(CustomerNotification, 'findOneAndUpdate').mockReturnValue({
    lean: async () => {
      if (!first) return null;
      first = false;
      return event;
    },
  } as unknown as ReturnType<typeof CustomerNotification.findOneAndUpdate>);
  mocks.push(claim);
  const account = spyOn(CustomerAccount, 'findById').mockReturnValue(
    chain({ sessions: [{ id: claims.sid, expiresAt: expiry }] }) as unknown as ReturnType<
      typeof CustomerAccount.findById
    >,
  );
  mocks.push(account);
  const tokens = spyOn(CustomerPushToken, 'find').mockReturnValue(
    chain([{ _id: 'retry-token', token: 'pending-fcm-token' }]) as unknown as ReturnType<
      typeof CustomerPushToken.find
    >,
  );
  mocks.push(tokens);
  const send = spyOn(push, 'sendCustomerPush').mockResolvedValue({ result: 'sent', retryAfterSeconds: 0 });
  mocks.push(send);
  const write = spyOn(CustomerNotification, 'updateOne').mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  });
  mocks.push(write);
  await deliverCustomerNotifications();
  const filter = tokens.mock.calls[0]![0] as unknown as { _id: { $nin: string[] } };
  expect(filter._id.$nin).toEqual(['already-sent']);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('pending-fcm-token', String(event._id));
  const update = write.mock.calls[0]![1] as unknown as {
    $addToSet: { deliveredTokens: { $each: string[] } };
  };
  expect(update.$addToSet.deliveredTokens.$each).toEqual(['retry-token']);
});

test('due reminders use tenant scoped aggregation and bounded bulk batches', async () => {
  const { Org } = await import('../src/models/org');
  const { Installment } = await import('../src/models/installment');
  const { sendCustomerDueReminders } = await import('../src/lib/customer_notifications');
  const orgId = new Types.ObjectId();
  const accountId = new Types.ObjectId();
  const contractId = new Types.ObjectId();
  const orgs = spyOn(Org, 'find').mockReturnValue(
    chain([{ _id: orgId }]) as unknown as ReturnType<typeof Org.find>,
  );
  mocks.push(orgs);
  async function* dueRows() {
    for (let i = 0; i < 101; i++) yield { _id: new Types.ObjectId(), contractId, accountId };
  }
  const aggregate = spyOn(Installment, 'aggregate').mockReturnValue({
    cursor: () => dueRows(),
  } as unknown as ReturnType<typeof Installment.aggregate>);
  mocks.push(aggregate);
  const bulk = spyOn(CustomerNotification, 'bulkWrite').mockResolvedValue(
    {} as Awaited<ReturnType<typeof CustomerNotification.bulkWrite>>,
  );
  mocks.push(bulk);
  const claim = spyOn(CustomerNotification, 'findOneAndUpdate').mockReturnValue({
    lean: async () => null,
  } as unknown as ReturnType<typeof CustomerNotification.findOneAndUpdate>);
  mocks.push(claim);
  await sendCustomerDueReminders();
  expect(aggregate).toHaveBeenCalledTimes(1);
  const pipeline = aggregate.mock.calls[0]![0] as unknown as { $match: { orgId: Types.ObjectId } }[];
  expect(String(pipeline[0]!.$match.orgId)).toBe(String(orgId));
  expect(bulk.mock.calls.map((args) => (args[0] as unknown[]).length)).toEqual([100, 1]);
});
