import { beforeAll, describe, expect, test } from 'bun:test';
import { addDays, todayInShops, type Branch, type Collections, type ContractWithSchedule, type Customer, type Device, type Page, type Payment } from '@shop/shared';
import { addMember, call, newCustomer, prepareDatabase, randomImei, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('payments', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>;
  let mainBranch: string;
  let secondBranch: string;
  let customer: Customer;

  /** Rs 3,000 in 3 monthly installments of Rs 1,000, plus an optional down payment. */
  async function sell(downPayment = 0) {
    const device = (await call<Device>('POST', '/devices', { token: shop.token, body: { branchId: mainBranch, brand: 'Tecno', model: 'Spark 20', imeis: [randomImei()] } })).data;
    const res = await call<ContractWithSchedule>('POST', '/contracts', {
      token: shop.token,
      body: { branchId: mainBranch, customerId: customer._id, deviceId: device._id, cashPrice: 300_000 + downPayment, downPayment, markupPercent: 0, count: 3, frequency: 'monthly', firstDueDate: addDays(todayInShops(), 10) },
    });
    return { contract: res.data, device };
  }

  const pay = (contractId: string, amount: number, { key = crypto.randomUUID(), token = shop.token, branchId = mainBranch, method = 'cash' } = {}) =>
    call<Payment>('POST', `/contracts/${contractId}/payments`, { token, body: { branchId, amount, method }, headers: { 'Idempotency-Key': key } });
  const contractOf = async (id: string) => (await call<ContractWithSchedule>('GET', `/contracts/${id}`, { token: shop.token })).data;
  const ledgerOf = async (id: string) => (await call<Payment[]>('GET', `/contracts/${id}/payments`, { token: shop.token })).data;

  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
    mainBranch = shop.session.branches[0]._id;
    secondBranch = (await call<Branch>('POST', '/branches', { token: shop.token, body: { name: 'Saddar' } })).data._id;
    customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(mainBranch) })).data;
  });

  test('the down payment gets a receipt at sale; receipt numbers count up per branch', async () => {
    const { contract } = await sell(50_000);
    const [down] = await ledgerOf(contract._id);
    expect(down).toMatchObject({ kind: 'down_payment', amount: 50_000, allocations: [] });

    const next = await pay(contract._id, 10_000);
    expect(next.status).toBe(201);
    expect(next.data.receiptNumber).toBe(down.receiptNumber + 1);
    const elsewhere = await pay(contract._id, 10_000, { branchId: secondBranch });
    expect(elsewhere.data).toMatchObject({ receiptNumber: 1, branch: { name: 'Saddar' } });
  });

  test('oldest installment first: part payments, then an advance; more than outstanding is refused', async () => {
    const { contract } = await sell();
    await pay(contract._id, 50_000);
    expect((await contractOf(contract._id)).installments.map((i) => [i.paidAmount, i.status])).toEqual([[50_000, 'partial'], [0, 'pending'], [0, 'pending']]);

    await pay(contract._id, 120_000);
    const after = await contractOf(contract._id);
    expect(after.installments.map((i) => [i.paidAmount, i.status])).toEqual([[100_000, 'paid'], [70_000, 'partial'], [0, 'pending']]);
    expect(after.paidTotal).toBe(170_000);

    const tooMuch = await pay(contract._id, 130_001);
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.error?.details).toMatchObject({ fields: [{ path: 'amount' }] });
  });

  test('a retried request records the payment once; a reused key with other details is refused', async () => {
    const { contract } = await sell();
    const key = crypto.randomUUID();
    const first = await pay(contract._id, 40_000, { key });
    const retry = await pay(contract._id, 40_000, { key });
    expect(retry.status).toBe(200);
    expect(retry.data._id).toBe(first.data._id);
    expect((await contractOf(contract._id)).paidTotal).toBe(40_000);

    expect((await pay(contract._id, 99_000, { key })).status).toBe(409);
    const noKey = await call('POST', `/contracts/${contract._id}/payments`, { token: shop.token, body: { branchId: mainBranch, amount: 1_000, method: 'cash' } });
    expect(noKey.status).toBe(400);
  });

  test('two different payments at the same moment both count', async () => {
    const { contract } = await sell();
    const results = await Promise.all([pay(contract._id, 60_000), pay(contract._id, 60_000)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const after = await contractOf(contract._id);
    expect(after.paidTotal).toBe(120_000);
    expect(after.installments.map((i) => i.paidAmount)).toEqual([100_000, 20_000, 0]);
  });

  test('paying off completes the contract and releases the phone; a void reopens both exactly', async () => {
    const { contract, device } = await sell();
    await pay(contract._id, 100_000);
    const last = await pay(contract._id, 200_000);
    expect((await contractOf(contract._id)).status).toBe('completed');
    const released = await call<Page<Device>>('GET', `/devices?q=${device.imeis[0]}&status=released`, { token: shop.token });
    expect(released.data.items).toHaveLength(1);

    const voided = await call<Payment>('POST', `/payments/${last.data._id}/void`, { token: shop.token, body: { reason: 'Cheque bounced' } });
    expect(voided.data).toMatchObject({ voidReason: 'Cheque bounced' });
    expect(voided.data.voidedAt).not.toBeNull();
    const reopened = await contractOf(contract._id);
    expect(reopened).toMatchObject({ status: 'active', paidTotal: 100_000 });
    expect(reopened.installments.map((i) => [i.paidAmount, i.status])).toEqual([[100_000, 'paid'], [0, 'pending'], [0, 'pending']]);
    expect((await call<Page<Device>>('GET', `/devices?q=${device.imeis[0]}&status=sold`, { token: shop.token })).data.items).toHaveLength(1);
  });

  test('voids: managers and owners, at the receiving branch, once; never a down payment', async () => {
    const { contract } = await sell(20_000);
    const payment = (await pay(contract._id, 30_000)).data;
    const staff = await addMember(shop.token, 'staff', [mainBranch]);
    const managerElsewhere = await addMember(shop.token, 'manager', [secondBranch]);
    const voidAs = (token: string, id = payment._id) => call('POST', `/payments/${id}/void`, { token, body: { reason: 'Entered twice' } });

    expect((await voidAs(staff.token)).status).toBe(403);
    expect((await voidAs(managerElsewhere.token)).status).toBe(403);
    expect((await voidAs(shop.token)).status).toBe(200);
    expect((await voidAs(shop.token)).status).toBe(409);
    const down = (await ledgerOf(contract._id)).find((p) => p.kind === 'down_payment');
    expect((await voidAs(shop.token, down?._id)).status).toBe(409);
  });

  test("a day's collections, by method and by person, leave voids out", async () => {
    const other = await signupOrg('Collections Shop');
    const branch = other.session.branches[0]._id;
    const buyer = (await call<Customer>('POST', '/customers', { token: other.token, body: newCustomer(branch) })).data;
    const device = (await call<Device>('POST', '/devices', { token: other.token, body: { branchId: branch, brand: 'Vivo', model: 'Y17', imeis: [randomImei()] } })).data;
    const contract = (
      await call<ContractWithSchedule>('POST', '/contracts', {
        token: other.token,
        body: { branchId: branch, customerId: buyer._id, deviceId: device._id, cashPrice: 400_000, downPayment: 100_000, markupPercent: 0, count: 3, frequency: 'monthly', firstDueDate: addDays(todayInShops(), 10) },
      })
    ).data;
    const payIn = (amount: number, method: string) => pay(contract._id, amount, { token: other.token, branchId: branch, method });
    await payIn(50_000, 'jazzcash');
    const mistake = (await payIn(20_000, 'cash')).data;
    await call('POST', `/payments/${mistake._id}/void`, { token: other.token, body: { reason: 'Wrong customer' } });

    const res = await call<Collections>('GET', `/payments/collections?date=${todayInShops()}`, { token: other.token });
    expect(res.data).toMatchObject({ total: 150_000, count: 2 });
    expect(res.data.byMethod).toEqual([
      { method: 'cash', total: 100_000, count: 1 },
      { method: 'jazzcash', total: 50_000, count: 1 },
    ]);
    expect(res.data.byStaff).toEqual([{ userId: other.session.user._id, name: 'Owner Person', total: 150_000, count: 2 }]);
  });

  test('cancelling a sale voids its down payment', async () => {
    const { contract } = await sell(25_000);
    await call('POST', `/contracts/${contract._id}/cancel`, { token: shop.token, body: { reason: 'Customer changed their mind' } });
    const [down] = await ledgerOf(contract._id);
    expect(down).toMatchObject({ kind: 'down_payment', voidReason: 'Contract cancelled' });
  });
});
