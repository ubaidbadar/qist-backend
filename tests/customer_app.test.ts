import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { ContractWithSchedule, Customer, CustomerAppOverview, CustomerAppPayment, CustomerAppSession, Device, Page } from '@shop/shared';
import { addDays, todayInShops } from '@shop/shared';
import { Types } from 'mongoose';
import { CustomerAccount } from '../src/models/customer_account';
import { Org } from '../src/models/org';
import { Payment } from '../src/models/payment';
import { whatsappTestOutbox, whatsappCodeMessage } from '../src/lib/whatsapp';
import { addMember, call, newCustomer, PASSWORD, prepareDatabase, randomImei, randomMobile, signupOrg } from './api';
import { hasDatabase } from './setup';

test('WhatsApp authentication message repeats the OTP in the body and copy-code URL button', () => {
  const message = whatsappCodeMessage('03001234567', '012345');
  expect(message.to).toBe('923001234567');
  expect(message.template.components.map((component) => component.parameters[0].text)).toEqual(['012345', '012345']);
});

describe.skipIf(!hasDatabase)('customer app', () => {
  beforeAll(prepareDatabase);
  async function buyer(phone = randomMobile(), withPlan = true) {
    const shop = await signupOrg();
    const branchId = shop.session.branches[0]._id;
    await call('PATCH', `/branches/${branchId}`, { token: shop.token, body: { phone: '03001234567', address: 'Main Road' } });
    const customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(branchId, { phone }) })).data;
    if (!withPlan) return { shop, customer, phone, contract: null, device: null };
    const device = (await call<Device>('POST', '/devices', { token: shop.token, body: { branchId, brand: 'Test', model: 'Phone', imeis: [randomImei()], costPrice: 100 } })).data;
    const sold = await call<ContractWithSchedule>('POST', '/contracts', { token: shop.token, body: {
      branchId, customerId: customer._id, deviceId: device._id, cashPrice: 400_000, downPayment: 100_000,
      markupPercent: 0, count: 3, frequency: 'monthly', firstDueDate: addDays(todayInShops(), 10),
    } });
    expect(sold.status).toBe(201);
    return { shop, customer, phone, contract: sold.data, device };
  }
  async function codeFor(phone: string) {
    expect((await call('POST', '/customer-app/auth/forgot-password', { body: { phone } })).status).toBe(200);
    const message = whatsappTestOutbox.findLast((item) => item.phone === phone);
    if (!message) throw new Error('No test WhatsApp code');
    return message.code;
  }
  async function activate(phone: string) {
    const code = await codeFor(phone);
    expect((await call('POST', '/customer-app/auth/reset-password', { body: { phone, code, password: PASSWORD } })).status).toBe(200);
    const session = await call<CustomerAppSession>('POST', '/customer-app/auth/login', { body: { phone, password: PASSWORD } });
    expect(session.status).toBe(200);
    return session.data.accessToken;
  }
  const overview = (token: string, query = '') => call<CustomerAppOverview>('GET', '/customer-app/overview' + query, { token });

  test('verified WhatsApp setup, phone/password login and one-aggregate overview use real records', async () => {
    const { phone, contract } = await buyer();
    const token = await activate(phone);
    const aggregate = spyOn(CustomerAccount, 'aggregate');
    try {
      const result = await overview(token);
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(200);
      expect(result.data.contract).toMatchObject({ id: contract!._id, totalPayable: 300_000, paidTotal: 0, downPayment: 100_000, retailerPhone: '03001234567', deviceLockState: 'unlocked' });
      expect(result.data.contract?.installments).toHaveLength(3);
      expect(result.data.payments.items[0]).toMatchObject({ kind: 'down_payment', amount: 100_000 });
      const json = JSON.stringify(result.data);
      for (const field of ['cnic', 'guarantors', 'passwordHash', 'tokenVersion', 'sessions', 'secretHash', 'costPrice', 'imeis']) expect(json).not.toContain(`"${field}"`);
    } finally { aggregate.mockRestore(); }
    const formatted = '+92 ' + phone.slice(1);
    expect((await call('POST', '/customer-app/auth/login', { body: { phone: formatted, password: PASSWORD } })).status).toBe(200);
  });
  test('deleting an app identity revokes all sessions and retains retailer records', async () => {
    const { phone, customer, contract, shop } = await buyer();
    const token = await activate(phone);
    const second = (await call<CustomerAppSession>('POST', '/customer-app/auth/login', { body: { phone, password: PASSWORD } })).data.accessToken;
    const before = await overview(token);
    expect((await call('DELETE', '/customer-app/account', { token })).status).toBe(200);
    expect(await CustomerAccount.exists({ phone })).toBeNull();
    expect((await overview(token)).status).toBe(401);
    expect((await overview(second)).status).toBe(401);
    expect((await call('GET', `/customers/${customer._id}`, { token: shop.token })).status).toBe(200);
    expect((await call('GET', `/contracts/${contract!._id}`, { token: shop.token })).status).toBe(200);
    expect(await Payment.countDocuments({ contractId: new Types.ObjectId(contract!._id) })).toBe(before.data.payments.items.length);
    const start = await call<{ next: string }>('POST', '/customer-app/auth/start', { body: { phone } });
    expect(start.data.next).toBe('otp');
  });
  test('only enabled instructions for the selected retailer reach the customer', async () => {
    const a = await buyer(); const b = await buyer(a.phone); const token = await activate(a.phone);
    const wallet = { id: crypto.randomUUID(), kind: 'jazzcash' as const, enabled: true, accountTitle: 'Retailer A', accountNumber: '03001234567' };
    const hidden = { id: crypto.randomUUID(), kind: 'cash', enabled: false };
    expect((await call('PATCH', '/org/payment-methods', { token: a.shop.token, body: { paymentMethods: [wallet, hidden] } })).status).toBe(200);
    expect((await call('PATCH', '/org/payment-methods', { token: b.shop.token, body: { paymentMethods: [{ id: crypto.randomUUID(), kind: 'cash', enabled: true }] } })).status).toBe(200);
    const staff = await addMember(a.shop.token, 'staff', [a.shop.session.branches[0]._id]);
    expect((await call('PATCH', '/org/payment-methods', { token: staff.token, body: { paymentMethods: [] } })).status).toBe(403);
    expect((await overview(token, `?contractId=${a.contract!._id}`)).data.contract?.paymentMethods).toEqual([wallet]);
    const other = (await overview(token, `?contractId=${b.contract!._id}`)).data.contract?.paymentMethods;
    expect(other).toHaveLength(1);
    expect(other?.[0].kind).toBe('cash');
    expect(JSON.stringify(other)).not.toContain('Retailer A');
    expect((await call('PATCH', '/org/payment-methods', { token: a.shop.token, body: { paymentMethods: [] } })).status).toBe(200);
    expect((await overview(token, `?contractId=${a.contract!._id}`)).data.contract?.paymentMethods).toEqual([]);
  });
  test('staff and customer tokens cannot cross authentication boundaries; unowned ids are refused', async () => {
    const a = await buyer(); const b = await buyer(); const token = await activate(a.phone);
    expect((await overview(a.shop.token)).status).toBe(401);
    expect((await call('GET', '/me', { token })).status).toBe(401);
    expect((await overview(token, `?contractId=${b.contract!._id}`)).status).toBe(404);
    expect((await call('GET', `/customer-app/payments?contractId=${b.contract!._id}`, { token })).status).toBe(404);
    expect((await overview('not-a-token')).status).toBe(401);
  });
  test('the same verified phone sees its own plans at multiple active retailers only', async () => {
    const a = await buyer(); const b = await buyer(a.phone); const token = await activate(a.phone);
    expect((await overview(token)).data.contracts).toHaveLength(2);
    await Org.updateOne({ _id: b.shop.session.org._id }, { $set: { status: 'suspended' } });
    expect((await overview(token)).data.contracts.map((item) => item.id)).toEqual([a.contract!._id]);
  });
  test('empty accounts return an honest empty plan; unknown phones get the same recovery envelope with no message', async () => {
    const { phone } = await buyer(randomMobile(), false); const token = await activate(phone);
    expect((await overview(token)).data).toMatchObject({ contract: null, contracts: [], payments: { items: [], nextCursor: null } });
    const before = whatsappTestOutbox.length;
    const unknown = await call('POST', '/customer-app/auth/forgot-password', { body: { phone: randomMobile() } });
    const known = await call('POST', '/customer-app/auth/forgot-password', { body: { phone } });
    expect(unknown.data).toEqual(known.data);
    expect(whatsappTestOutbox.length).toBe(before); // known phone still in cooldown
    expect((await call('POST', '/customer-app/auth/login', { body: { phone, password: 'wrong-password' } })).status).toBe(401);
  });
  test('a reset is single-use, signs out old sessions, and the old password stops working', async () => {
    const { phone } = await buyer(); const token = await activate(phone);
    await CustomerAccount.updateOne({ phone }, { $unset: { reset: 1 }, $set: { resetWindowStart: new Date(0), lastResetSentAt: new Date(0) } });
    const code = await codeFor(phone); const body = { phone, code, password: 'a-new-safe-password' };
    expect((await call('POST', '/customer-app/auth/reset-password', { body })).status).toBe(200);
    expect((await call('POST', '/customer-app/auth/reset-password', { body })).status).toBe(400);
    expect((await overview(token)).status).toBe(401);
    expect((await call('POST', '/customer-app/auth/login', { body: { phone, password: PASSWORD } })).status).toBe(401);
    expect((await call('POST', '/customer-app/auth/login', { body: { phone, password: body.password } })).status).toBe(200);
  });
  test('expiry and five-guess limit are enforced atomically, and requesting again observes cooldown', async () => {
    const { phone } = await buyer(); const code = await codeFor(phone);
    const count = whatsappTestOutbox.length;
    await call('POST', '/customer-app/auth/forgot-password', { body: { phone } });
    expect(whatsappTestOutbox.length).toBe(count);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await call('POST', '/customer-app/auth/reset-password', { body: { phone, code: wrong, password: PASSWORD } })).status).toBe(400);
    expect((await call('POST', '/customer-app/auth/reset-password', { body: { phone, code, password: PASSWORD } })).status).toBe(400);
    await CustomerAccount.updateOne({ phone }, { $set: { 'reset.attempts': 0, 'reset.expiresAt': new Date(0) } });
    expect((await call('POST', '/customer-app/auth/reset-password', { body: { phone, code, password: PASSWORD } })).status).toBe(400);
  });
  test('only one concurrent reset wins and logout revokes just that session', async () => {
    const { phone } = await buyer(); const code = await codeFor(phone);
    const resets = await Promise.all([0, 1].map(() => call('POST', '/customer-app/auth/reset-password', { body: { phone, code, password: PASSWORD } })));
    expect(resets.map((item) => item.status).sort()).toEqual([200, 400]);
    const login = () => call<CustomerAppSession>('POST', '/customer-app/auth/login', { body: { phone, password: PASSWORD } });
    const a = (await login()).data.accessToken; const b = (await login()).data.accessToken;
    expect((await call('POST', '/customer-app/auth/logout', { token: a })).status).toBe(200);
    expect((await overview(a)).status).toBe(401); expect((await overview(b)).status).toBe(200);
  });
  test('the hourly WhatsApp send cap survives code replacement', async () => {
    const { phone } = await buyer();
    const count = whatsappTestOutbox.length;
    for (let i = 0; i < 6; i++) {
      await CustomerAccount.updateOne({ phone }, { $set: { lastResetSentAt: new Date(0) } });
      expect((await call('POST', '/customer-app/auth/forgot-password', { body: { phone } })).status).toBe(200);
    }
    expect(whatsappTestOutbox.length - count).toBe(5);
  });
  test('payments are paginated once, without voided records or duplicate rows', async () => {
    const { phone, contract, shop, customer } = await buyer(); const token = await activate(phone);
    await Payment.insertMany(Array.from({ length: 25 }, (_, i) => ({
      orgId: new Types.ObjectId(shop.session.org._id), branchId: new Types.ObjectId(shop.session.branches[0]._id),
      contractId: new Types.ObjectId(contract!._id), customerId: new Types.ObjectId(customer._id), customerName: customer.fullName,
      deviceLabel: 'Test Phone', kind: 'installment', amount: 100, method: 'cash', receiptNumber: i + 2,
      receivedBy: new Types.ObjectId(shop.session.user._id), receivedByName: 'Owner', receivedOn: todayInShops(), voidedAt: i === 24 ? new Date() : null,
    })));
    const first = (await overview(token)).data.payments;
    expect(first.items).toHaveLength(20); expect(first.nextCursor).not.toBeNull();
    const next = await call<Page<CustomerAppPayment>>('GET', `/customer-app/payments?contractId=${contract!._id}&cursor=${first.nextCursor}`, { token });
    expect(next.status).toBe(200); expect(next.data.items).toHaveLength(5); expect(next.data.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.data.items].map((item) => item.id)).size).toBe(25);
  });
  test('phone-first login requires a plan and sends OTP only when no password exists', async () => {
    const unknown = randomMobile();
    expect((await call('POST', '/customer-app/auth/start', { body: { phone: unknown } })).data).toEqual({ next: 'unregistered' });
    const noPlan = await buyer(randomMobile(), false);
    expect((await call('POST', '/customer-app/auth/start', { body: { phone: noPlan.phone } })).data).toEqual({ next: 'unregistered' });
    const { phone } = await buyer();
    const before = whatsappTestOutbox.length;
    const first = await call<{ next: string; retryAfterSeconds: number }>('POST', '/customer-app/auth/start', { body: { phone } });
    expect(first.status).toBe(200); expect(first.data).toMatchObject({ next: 'otp', retryAfterSeconds: 60 });
    expect(whatsappTestOutbox.length).toBe(before + 1);
    expect((await call('POST', '/customer-app/auth/start', { body: { phone } })).status).toBe(200);
    expect(whatsappTestOutbox.length).toBe(before + 1);
    const code = whatsappTestOutbox.at(-1)!.code;
    const proof = await call<{ setupToken: string }>('POST', '/customer-app/auth/verify-code', { body: { phone, code } });
    expect(proof.status).toBe(200); expect(proof.data.setupToken).toHaveLength(43);
    expect((await overview(proof.data.setupToken)).status).toBe(401);
    expect((await call('POST', '/customer-app/auth/verify-code', { body: { phone, code } })).status).toBe(400);
    const session = await call<CustomerAppSession>('POST', '/customer-app/auth/set-password', { body: { phone, setupToken: proof.data.setupToken, password: PASSWORD } });
    expect(session.status).toBe(200); expect((await overview(session.data.accessToken)).status).toBe(200);
    expect((await call('POST', '/customer-app/auth/set-password', { body: { phone, setupToken: proof.data.setupToken, password: PASSWORD } })).status).toBe(400);
    const sent = whatsappTestOutbox.length;
    expect((await call('POST', '/customer-app/auth/start', { body: { phone } })).data).toEqual({ next: 'password' });
    expect(whatsappTestOutbox.length).toBe(sent);
    expect((await call('POST', '/customer-app/auth/login', { body: { phone, password: PASSWORD } })).status).toBe(200);
  });
  test('setup proof is phone bound, expires, and cannot survive a new challenge', async () => {
    const { phone } = await buyer();
    const code = await codeFor(phone);
    const proof = (await call<{ setupToken: string }>('POST', '/customer-app/auth/verify-code', { body: { phone, code } })).data.setupToken;
    expect((await call('POST', '/customer-app/auth/set-password', { body: { phone: randomMobile(), setupToken: proof, password: PASSWORD } })).status).toBe(400);
    await CustomerAccount.updateOne({ phone }, { $set: { lastResetSentAt: new Date(0) } });
    await codeFor(phone);
    expect((await call('POST', '/customer-app/auth/set-password', { body: { phone, setupToken: proof, password: PASSWORD } })).status).toBe(400);
    const nextCode = whatsappTestOutbox.at(-1)!.code;
    const next = (await call<{ setupToken: string }>('POST', '/customer-app/auth/verify-code', { body: { phone, code: nextCode } })).data.setupToken;
    await CustomerAccount.updateOne({ phone }, { $set: { 'setup.expiresAt': new Date(0) } });
    expect((await call('POST', '/customer-app/auth/set-password', { body: { phone, setupToken: next, password: PASSWORD } })).status).toBe(400);
  });
  test('concurrent OTP verification and password creation each have only one winner', async () => {
    const { phone } = await buyer(); const code = await codeFor(phone);
    const attempts = await Promise.all([0, 1].map(() => call<{ setupToken: string }>('POST', '/customer-app/auth/verify-code', { body: { phone, code } })));
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 400]);
    const setupToken = attempts.find((r) => r.status === 200)!.data.setupToken;
    const saves = await Promise.all([0, 1].map(() => call<CustomerAppSession>('POST', '/customer-app/auth/set-password', { body: { phone, setupToken, password: PASSWORD } })));
    expect(saves.map((r) => r.status).sort()).toEqual([200, 400]);
  });
  test('OTP verification shares the five-guess limit with legacy reset', async () => {
    const { phone } = await buyer(); const code = await codeFor(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await call('POST', '/customer-app/auth/verify-code', { body: { phone, code: wrong } })).status).toBe(400);
    expect((await call('POST', '/customer-app/auth/verify-code', { body: { phone, code } })).status).toBe(400);
  });
  test('suspended retailers cannot trigger phone-first onboarding', async () => {
    const { phone, shop } = await buyer();
    await Org.updateOne({ _id: shop.session.org._id }, { $set: { status: 'suspended' } });
    const before = whatsappTestOutbox.length;
    expect((await call('POST', '/customer-app/auth/start', { body: { phone } })).data).toEqual({ next: 'unregistered' });
    expect(whatsappTestOutbox.length).toBe(before);
  });

});
