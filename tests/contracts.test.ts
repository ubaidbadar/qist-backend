import { beforeAll, describe, expect, test } from 'bun:test';
import { addDays, todayInShops, type Branch, type ContractWithSchedule, type Customer, type Device, type InstallmentPlan, type Page } from '@shop/shared';
import { addMember, call, newCustomer, prepareDatabase, randomImei, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('contracts', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>;
  let mainBranch: string;
  let secondBranch: string;
  let customer: Customer;

  const addDevice = async (branchId: string) =>
    (await call<Device>('POST', '/devices', { token: shop.token, body: { branchId, brand: 'Infinix', model: 'Hot 40', imeis: [randomImei()] } })).data;

  const terms = (deviceId: string, overrides: Record<string, unknown> = {}) => ({
    branchId: mainBranch,
    customerId: customer._id,
    deviceId,
    cashPrice: 6_000_000,
    downPayment: 1_000_000,
    markupPercent: 25,
    count: 7,
    frequency: 'monthly',
    firstDueDate: addDays(todayInShops(), 30),
    ...overrides,
  });

  const sell = (body: Record<string, unknown>, token = shop.token) => call<ContractWithSchedule>('POST', '/contracts', { token, body });

  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
    mainBranch = shop.session.branches[0]._id;
    secondBranch = (await call<Branch>('POST', '/branches', { token: shop.token, body: { name: 'Saddar' } })).data._id;
    customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(mainBranch) })).data;
  });

  test('a sale stores exact amounts and a schedule that adds up to the total; the phone is sold', async () => {
    const device = await addDevice(mainBranch);
    const res = await sell(terms(device._id));
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      financedAmount: 5_000_000,
      markupAmount: 1_250_000,
      totalPayable: 6_250_000,
      status: 'active',
      deviceLockState: 'unlocked',
      customerName: customer.fullName,
      deviceLabel: 'Infinix Hot 40',
      branch: { name: 'Main Branch' },
    });
    expect(res.data.installments).toHaveLength(7);
    expect(res.data.installments.reduce((sum, i) => sum + i.amount, 0)).toBe(6_250_000);
    expect(res.data.installments.at(-1)?.amount).toBe(6_250_000 - 6 * Math.floor(6_250_000 / 7));

    const stock = await call<Page<Device>>('GET', `/devices?q=${device.imeis[0]}&status=sold`, { token: shop.token });
    expect(stock.data.items.map((d) => d._id)).toEqual([device._id]);
    expect((await sell(terms(device._id))).status).toBe(409);
  });

  test('bad terms are refused', async () => {
    const device = await addDevice(mainBranch);
    expect((await sell(terms(device._id, { downPayment: 6_000_000 }))).status).toBe(400);
    expect((await sell(terms(device._id, { firstDueDate: addDays(todayInShops(), -1) }))).status).toBe(400);
    expect((await sell(terms(device._id, { firstDueDate: '2026-02-30' }))).status).toBe(400);
    const elsewhere = await addDevice(secondBranch);
    expect((await sell(terms(elsewhere._id))).error?.details).toMatchObject({ fields: [{ path: 'deviceId' }] });
  });

  test("a plan's minimum down payment is enforced; only owners manage plans", async () => {
    const plan = await call<InstallmentPlan>('POST', '/plans', {
      token: shop.token,
      body: { name: '6 months', frequency: 'monthly', count: 6, markupPercent: 20, minDownPaymentPercent: 20 },
    });
    expect(plan.status).toBe(201);
    const device = await addDevice(mainBranch);
    const below = await sell(terms(device._id, { planId: plan.data._id, downPayment: 1_000_000 }));
    expect(below.error?.details).toMatchObject({ fields: [{ path: 'downPayment' }] });
    expect((await sell(terms(device._id, { planId: plan.data._id, downPayment: 1_200_000 }))).status).toBe(201);

    const staff = await addMember(shop.token, 'staff', [mainBranch]);
    expect((await call('GET', '/plans', { token: staff.token })).status).toBe(200);
    expect((await call('POST', '/plans', { token: staff.token, body: { name: 'x', frequency: 'weekly', count: 4, markupPercent: 0 } })).status).toBe(403);
  });

  test('contracts are read across branches, but sold only where you work', async () => {
    const device = await addDevice(mainBranch);
    const contract = (await sell(terms(device._id))).data;
    const staffElsewhere = await addMember(shop.token, 'staff', [secondBranch]);

    expect((await call('GET', `/contracts/${contract._id}`, { token: staffElsewhere.token })).status).toBe(200);
    const byCustomer = await call<Page<ContractWithSchedule>>('GET', `/contracts?customerId=${customer._id}`, { token: staffElsewhere.token });
    expect(byCustomer.data.items.map((c) => c._id)).toContain(contract._id);
    const ownBranches = await call<Page<ContractWithSchedule>>('GET', '/contracts', { token: staffElsewhere.token });
    expect(ownBranches.data.items.map((c) => c._id)).not.toContain(contract._id);

    expect((await sell(terms((await addDevice(mainBranch))._id), staffElsewhere.token)).status).toBe(403);
  });

  test('cancelling returns the phone to stock; customers with contracts cannot be deleted', async () => {
    const device = await addDevice(mainBranch);
    const contract = (await sell(terms(device._id))).data;
    const staff = await addMember(shop.token, 'staff', [mainBranch]);
    const cancel = (token: string) => call<ContractWithSchedule>('POST', `/contracts/${contract._id}/cancel`, { token, body: { reason: 'Customer changed their mind' } });

    expect((await cancel(staff.token)).status).toBe(403);
    const cancelled = await cancel(shop.token);
    expect(cancelled.data).toMatchObject({ status: 'cancelled', cancelReason: 'Customer changed their mind' });
    expect((await cancel(shop.token)).status).toBe(409);
    expect((await sell(terms(device._id))).status).toBe(201);

    expect((await call('DELETE', `/customers/${customer._id}`, { token: shop.token })).status).toBe(409);
  });
});
