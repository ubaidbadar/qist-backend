import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type {
  ContractWithSchedule,
  Customer,
  CustomerAppOverview,
  CustomerAppPayment,
  CustomerAppSession,
  Device,
  Page,
} from '@shop/shared';
import { addDays, todayInShops, type DeviceCredential, type EnrollmentTicket } from '@shop/shared';
import { Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { CustomerAccount } from '../src/models/customer_account';
import { Org } from '../src/models/org';
import { CustomerNotification } from '../src/models/customer_notification';
import { notifyCustomerChange } from '../src/lib/customer_notifications';
import { Payment } from '../src/models/payment';
import { hashPassword } from '../src/lib/passwords';
import { createHmac } from 'node:crypto';
import { env } from '../src/config/env';
import {
  addMember,
  call,
  newCustomer,
  PASSWORD,
  prepareDatabase,
  randomImei,
  randomMobile,
  signupOrg,
} from './api';
import { hasDatabase } from './setup';

test('external-message authentication endpoints are retired before database access', async () => {
  for (const path of ['request-code', 'verify-code', 'forgot-password', 'reset-password']) {
    const result = await call('POST', `/customer-app/auth/${path}`, {
      body: { phone: '03001234567', code: '123456', password: PASSWORD },
    });
    expect(result.status).toBe(410);
    expect(result.data).toBeUndefined();
  }
});

describe.skipIf(!hasDatabase)('customer app', () => {
  beforeAll(prepareDatabase);
  async function buyer(phone = randomMobile(), withPlan = true) {
    const shop = await signupOrg();
    const branchId = shop.session.branches[0]._id;
    await call('PATCH', `/branches/${branchId}`, {
      token: shop.token,
      body: { phone: '03001234567', address: 'Main Road' },
    });
    const customer = (
      await call<Customer>('POST', '/customers', {
        token: shop.token,
        body: newCustomer(branchId, { phone }),
      })
    ).data;
    if (!withPlan) return { shop, customer, phone, contract: null, device: null };
    const device = (
      await call<Device>('POST', '/devices', {
        token: shop.token,
        body: { branchId, brand: 'Test', model: 'Phone', imeis: [randomImei()], costPrice: 100 },
      })
    ).data;
    const sold = await call<ContractWithSchedule>('POST', '/contracts', {
      token: shop.token,
      body: {
        branchId,
        customerId: customer._id,
        deviceId: device._id,
        cashPrice: 400_000,
        downPayment: 100_000,
        markupPercent: 0,
        count: 3,
        frequency: 'monthly',
        firstDueDate: addDays(todayInShops(), 10),
      },
    });
    expect(sold.status).toBe(201);
    return { shop, customer, phone, contract: sold.data, device };
  }
  // These overview/payment tests arrange an existing verified account; device-proof issuance is tested separately.
  async function activate(phone: string) {
    await CustomerAccount.findOneAndUpdate(
      { phone },
      { $set: { passwordHash: await hashPassword(PASSWORD) } },
      { upsert: true },
    );
    const session = await call<CustomerAppSession>('POST', '/customer-app/auth/login', {
      body: { phone, password: PASSWORD },
    });
    expect(session.status).toBe(200);
    return session.data.accessToken;
  }
  const overview = (token: string, query = '') =>
    call<CustomerAppOverview>('GET', '/customer-app/overview' + query, { token });

  test('bearer-only handoff is unavailable; password login remains supported', async () => {
    const { shop, device } = await buyer();
    const enrollment = await call<EnrollmentTicket>('POST', `/devices/${device!._id}/enrollment`, {
      token: shop.token,
    });
    const credential = await call<DeviceCredential>('POST', '/device/enroll', {
      body: { token: enrollment.data.token },
    });
    expect(
      (
        await call('POST', '/device/customer-auth/issue', {
          token: credential.data.token,
          body: { nonce: randomBytes(32).toString('base64url') },
        })
      ).status,
    ).toBe(503);
  });

  test('existing verified accounts, phone/password login and one-aggregate overview use real records', async () => {
    const { phone, contract } = await buyer();
    const token = await activate(phone);
    const aggregate = spyOn(CustomerAccount, 'aggregate');
    try {
      const result = await overview(token);
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(200);
      expect(result.data.contract).toMatchObject({
        id: contract!._id,
        totalPayable: 300_000,
        paidTotal: 0,
        downPayment: 100_000,
        retailerPhone: '03001234567',
        deviceLockState: 'unlocked',
      });
      expect(result.data.contract?.installments).toHaveLength(3);
      expect(result.data.payments.items[0]).toMatchObject({ kind: 'down_payment', amount: 100_000 });
      const json = JSON.stringify(result.data);
      for (const field of [
        'cnic',
        'guarantors',
        'passwordHash',
        'tokenVersion',
        'sessions',
        'secretHash',
        'costPrice',
        'imeis',
      ])
        expect(json).not.toContain(`"${field}"`);
    } finally {
      aggregate.mockRestore();
    }
    const formatted = '+92 ' + phone.slice(1);
    expect(
      (await call('POST', '/customer-app/auth/login', { body: { phone: formatted, password: PASSWORD } }))
        .status,
    ).toBe(200);
  });
  test('deleting an app identity revokes all sessions and retains retailer records', async () => {
    const { phone, customer, contract, shop } = await buyer();
    const token = await activate(phone);
    const second = (
      await call<CustomerAppSession>('POST', '/customer-app/auth/login', {
        body: { phone, password: PASSWORD },
      })
    ).data.accessToken;
    const before = await overview(token);
    expect((await call('DELETE', '/customer-app/account', { token })).status).toBe(200);
    expect(await CustomerAccount.exists({ phone })).toBeNull();
    expect((await overview(token)).status).toBe(401);
    expect((await overview(second)).status).toBe(401);
    expect((await call('GET', `/customers/${customer._id}`, { token: shop.token })).status).toBe(200);
    expect((await call('GET', `/contracts/${contract!._id}`, { token: shop.token })).status).toBe(200);
    expect(
      await Payment.countDocuments({
        orgId: new Types.ObjectId(shop.session.org._id),
        contractId: new Types.ObjectId(contract!._id),
      }),
    ).toBe(before.data.payments.items.length);
    const start = await call<{ next: string }>('POST', '/customer-app/auth/start', { body: { phone } });
    expect(start.data.next).toBe('device');
  });
  test('only enabled instructions for the selected retailer reach the customer', async () => {
    const a = await buyer();
    const b = await buyer(a.phone);
    const token = await activate(a.phone);
    const wallet = {
      id: crypto.randomUUID(),
      kind: 'jazzcash' as const,
      enabled: true,
      accountTitle: 'Retailer A',
      accountNumber: '03001234567',
    };
    const hidden = { id: crypto.randomUUID(), kind: 'cash', enabled: false };
    expect(
      (
        await call('PATCH', '/org/payment-methods', {
          token: a.shop.token,
          body: { paymentMethods: [wallet, hidden] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('PATCH', '/org/payment-methods', {
          token: b.shop.token,
          body: { paymentMethods: [{ id: crypto.randomUUID(), kind: 'cash', enabled: true }] },
        })
      ).status,
    ).toBe(200);
    const staff = await addMember(a.shop.token, 'staff', [a.shop.session.branches[0]._id]);
    expect(
      (await call('PATCH', '/org/payment-methods', { token: staff.token, body: { paymentMethods: [] } }))
        .status,
    ).toBe(403);
    expect((await overview(token, `?contractId=${a.contract!._id}`)).data.contract?.paymentMethods).toEqual([
      wallet,
    ]);
    const other = (await overview(token, `?contractId=${b.contract!._id}`)).data.contract?.paymentMethods;
    expect(other).toHaveLength(1);
    expect(other?.[0].kind).toBe('cash');
    expect(JSON.stringify(other)).not.toContain('Retailer A');
    expect(
      (await call('PATCH', '/org/payment-methods', { token: a.shop.token, body: { paymentMethods: [] } }))
        .status,
    ).toBe(200);
    expect((await overview(token, `?contractId=${a.contract!._id}`)).data.contract?.paymentMethods).toEqual(
      [],
    );
  });
  test('staff and customer tokens cannot cross authentication boundaries; unowned ids are refused', async () => {
    const a = await buyer();
    const b = await buyer();
    const token = await activate(a.phone);
    expect((await overview(a.shop.token)).status).toBe(401);
    expect((await call('GET', '/me', { token })).status).toBe(401);
    expect((await overview(token, `?contractId=${b.contract!._id}`)).status).toBe(404);
    expect(
      (await call('GET', `/customer-app/payments?contractId=${b.contract!._id}`, { token })).status,
    ).toBe(404);
    expect((await overview('not-a-token')).status).toBe(401);
  });
  test('the same verified phone sees its own plans at multiple active retailers only', async () => {
    const a = await buyer();
    const b = await buyer(a.phone);
    const token = await activate(a.phone);
    expect((await overview(token)).data.contracts).toHaveLength(2);
    await Org.updateOne({ _id: b.shop.session.org._id }, { $set: { status: 'suspended' } });
    expect((await overview(token)).data.contracts.map((item) => item.id)).toEqual([a.contract!._id]);
  });
  test('empty accounts return an honest empty plan; removed recovery does not reveal account existence', async () => {
    const { phone } = await buyer(randomMobile(), false);
    const token = await activate(phone);
    expect((await overview(token)).data).toMatchObject({
      contract: null,
      contracts: [],
      payments: { items: [], nextCursor: null },
    });
    const unknown = await call('POST', '/customer-app/auth/forgot-password', {
      body: { phone: randomMobile() },
    });
    const known = await call('POST', '/customer-app/auth/forgot-password', { body: { phone } });
    expect(unknown.status).toBe(410);
    expect(known.status).toBe(410);
    expect(unknown.error?.message).toBe(known.error?.message);
    expect(
      (await call('POST', '/customer-app/auth/login', { body: { phone, password: 'wrong-password' } }))
        .status,
    ).toBe(401);
  });

  test('removed reset cannot change a password or revoke an existing verified session', async () => {
    const { phone } = await buyer();
    const token = await activate(phone);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await call('POST', '/customer-app/auth/reset-password', {
            body: { phone, code: '123456', password: 'replacement-password' },
          })
        ).status,
      ).toBe(410);
    expect((await overview(token)).status).toBe(200);
    expect(
      (await call('POST', '/customer-app/auth/login', { body: { phone, password: PASSWORD } })).status,
    ).toBe(200);
    expect(
      (await call('POST', '/customer-app/auth/login', { body: { phone, password: 'replacement-password' } }))
        .status,
    ).toBe(401);
  });

  test('removed code checks cannot create a first-password proof, even with repeated guesses', async () => {
    const { phone } = await buyer();
    for (let i = 0; i < 6; i++)
      expect(
        (await call('POST', '/customer-app/auth/verify-code', { body: { phone, code: '123456' } })).status,
      ).toBe(410);
    expect(await CustomerAccount.exists({ phone })).toBeNull();
  });

  test('concurrent removed resets fail closed and logout revokes only its own session', async () => {
    const { phone } = await buyer();
    await activate(phone);
    const resets = await Promise.all(
      [0, 1].map(() =>
        call('POST', '/customer-app/auth/reset-password', {
          body: { phone, code: '123456', password: PASSWORD },
        }),
      ),
    );
    expect(resets.map((item) => item.status)).toEqual([410, 410]);
    const login = () =>
      call<CustomerAppSession>('POST', '/customer-app/auth/login', { body: { phone, password: PASSWORD } });
    const a = (await login()).data.accessToken;
    const b = (await login()).data.accessToken;
    expect((await call('POST', '/customer-app/auth/logout', { token: a })).status).toBe(200);
    expect((await overview(a)).status).toBe(401);
    expect((await overview(b)).status).toBe(200);
  });

  test('removed message channels cannot issue reset state or send a provider request', async () => {
    const { phone } = await buyer();
    const fetch = spyOn(globalThis, 'fetch');
    try {
      for (let i = 0; i < 6; i++)
        expect((await call('POST', '/customer-app/auth/request-code', { body: { phone } })).status).toBe(410);
      expect(fetch).not.toHaveBeenCalled();
      expect(await CustomerAccount.exists({ phone })).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  test('payments are paginated once, without voided records or duplicate rows', async () => {
    const { phone, contract, shop, customer } = await buyer();
    const token = await activate(phone);
    await Payment.insertMany(
      Array.from({ length: 25 }, (_, i) => ({
        orgId: new Types.ObjectId(shop.session.org._id),
        branchId: new Types.ObjectId(shop.session.branches[0]._id),
        contractId: new Types.ObjectId(contract!._id),
        customerId: new Types.ObjectId(customer._id),
        customerName: customer.fullName,
        deviceLabel: 'Test Phone',
        kind: 'installment',
        amount: 100,
        method: 'cash',
        receiptNumber: i + 2,
        receivedBy: new Types.ObjectId(shop.session.user._id),
        receivedByName: 'Owner',
        receivedOn: todayInShops(),
        voidedAt: i === 24 ? new Date() : null,
      })),
    );
    const first = (await overview(token)).data.payments;
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const next = await call<Page<CustomerAppPayment>>(
      'GET',
      `/customer-app/payments?contractId=${contract!._id}&cursor=${first.nextCursor}`,
      { token },
    );
    expect(next.status).toBe(200);
    expect(next.data.items).toHaveLength(5);
    expect(next.data.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.data.items].map((item) => item.id)).size).toBe(25);
  });
  test('phone-first login routes to password or device verification without sending a code', async () => {
    const unknown = randomMobile();
    expect((await call('POST', '/customer-app/auth/start', { body: { phone: unknown } })).data).toEqual({
      next: 'unregistered',
    });
    const noPlan = await buyer(randomMobile(), false);
    expect((await call('POST', '/customer-app/auth/start', { body: { phone: noPlan.phone } })).data).toEqual({
      next: 'unregistered',
    });
    const { phone } = await buyer();
    expect((await call('POST', '/customer-app/auth/start', { body: { phone } })).data).toEqual({
      next: 'device',
    });
    expect(await CustomerAccount.exists({ phone })).toBeNull();
    await activate(phone);
    expect((await call('POST', '/customer-app/auth/start', { body: { phone } })).data).toEqual({
      next: 'password',
    });
  });

  test('unbound legacy setup tokens and expired proofs cannot set a password', async () => {
    const { phone } = await buyer();
    const proof = randomBytes(32).toString('base64url');
    await CustomerAccount.create({
      phone,
      setup: {
        digest: createHmac('sha256', env.JWT_REFRESH_SECRET)
          .update(`customer-setup:${phone}:${proof}`)
          .digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(
      (
        await call('POST', '/customer-app/auth/set-password', {
          body: { phone, setupToken: proof, password: PASSWORD },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/customer-app/auth/set-password', {
          body: { phone: randomMobile(), setupToken: proof, password: PASSWORD },
        })
      ).status,
    ).toBe(400);
    await CustomerAccount.updateOne({ phone }, { $set: { 'setup.expiresAt': new Date(0) } });
    expect(
      (
        await call('POST', '/customer-app/auth/set-password', {
          body: { phone, setupToken: proof, password: PASSWORD },
        })
      ).status,
    ).toBe(400);
  });

  test('concurrent calls to the removed OTP endpoint cannot mint first-password proofs', async () => {
    const { phone } = await buyer();
    const attempts = await Promise.all(
      [0, 1].map(() => call('POST', '/customer-app/auth/verify-code', { body: { phone, code: '123456' } })),
    );
    expect(attempts.map((r) => r.status)).toEqual([410, 410]);
    expect(attempts.every((r) => r.data === undefined)).toBe(true);
  });

  test('a phone and message code alone cannot impersonate an enrolled Locker proof', async () => {
    const { phone } = await buyer();
    expect(
      (await call('POST', '/customer-app/auth/device/verify-code', { body: { phone, code: '123456' } }))
        .status,
    ).toBe(400);
    expect(await CustomerAccount.exists({ phone })).toBeNull();
  });

  test('notification inbox and read markers stay scoped to the verified identity', async () => {
    const a = await buyer();
    const b = await buyer();
    const tokenA = await activate(a.phone);
    const tokenB = await activate(b.phone);
    await notifyCustomerChange(
      new Types.ObjectId(a.shop.session.org._id),
      new Types.ObjectId(a.customer._id),
      new Types.ObjectId(a.contract!._id),
      'payment',
      'test-payment',
      false,
    );
    const notices = (await overview(tokenA)).data.notifications;
    expect(notices).toHaveLength(1);
    expect((await overview(tokenB)).data.notifications).toEqual([]);
    const id = notices[0]!.id;
    expect(
      (await call('POST', '/customer-app/notifications/read', { token: tokenB, body: { ids: [id] } })).status,
    ).toBe(200);
    expect((await overview(tokenA)).data.notifications[0]!.read).toBe(false);
    expect(
      (await call('POST', '/customer-app/notifications/read', { token: tokenA, body: { ids: [id] } })).status,
    ).toBe(200);
    expect((await overview(tokenA)).data.notifications[0]!.read).toBe(true);
    expect((await call('DELETE', '/customer-app/account', { token: tokenA })).status).toBe(200);
    expect(await CustomerNotification.countDocuments({ _id: new Types.ObjectId(id) })).toBe(0);
  });
  test('suspended retailers cannot trigger phone-first onboarding', async () => {
    const { phone, shop } = await buyer();
    await Org.updateOne({ _id: shop.session.org._id }, { $set: { status: 'suspended' } });
    expect((await call('POST', '/customer-app/auth/start', { body: { phone } })).data).toEqual({
      next: 'unregistered',
    });
  });
});
