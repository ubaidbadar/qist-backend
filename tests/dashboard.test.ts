import { beforeAll, describe, expect, test } from 'bun:test';
import {
  addDays,
  todayInShops,
  type Branch,
  type Collections,
  type ContractWithSchedule,
  type Customer,
  type DashboardSnapshot,
  type Device,
  type OverdueAccount,
  type Page,
  type Payment,
} from '@shop/shared';
import { Types } from 'mongoose';
import { Installment } from '../src/models/installment';
import { addMember, call, newCustomer, prepareDatabase, randomImei, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('dashboard snapshot', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>;
  let firstBranch: string;
  let secondBranch: string;

  async function sell(branchId: string, downPayment: number) {
    const customer = (await call<Customer>('POST', '/customers', {
      token: shop.token,
      body: newCustomer(branchId),
    })).data;
    const phone = (await call<Device>('POST', '/devices', {
      token: shop.token,
      body: { branchId, brand: 'Vivo', model: 'Y02', imeis: [randomImei()] },
    })).data;
    const sale = await call<ContractWithSchedule>('POST', '/contracts', {
      token: shop.token,
      body: {
        branchId,
        customerId: customer._id,
        deviceId: phone._id,
        cashPrice: 300_000,
        downPayment,
        markupPercent: 0,
        count: 3,
        frequency: 'monthly',
        firstDueDate: addDays(todayInShops(), 5),
      },
    });
    expect(sale.status).toBe(201);
    return sale.data;
  }

  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
    firstBranch = shop.session.branches[0]._id;
    secondBranch = (await call<Branch>('POST', '/branches', { token: shop.token, body: { name: 'Second branch' } })).data._id;
  });

  async function compare(token: string, branchId?: string) {
    const date = todayInShops();
    const params = new URLSearchParams({ date, ...(branchId ? { branchId } : {}) });
    const branchQuery = branchId ? '?branchId=' + branchId : '';
    const [dashboard, overdue, payments, contracts, collections] = await Promise.all([
      call<DashboardSnapshot>('GET', '/dashboard?' + params.toString(), { token }),
      call<OverdueAccount[]>('GET', '/locks/overdue' + branchQuery, { token }),
      call<Page<Payment>>('GET', '/payments?' + new URLSearchParams({ date, limit: '5', ...(branchId ? { branchId } : {}) }), { token }),
      call<Page<ContractWithSchedule>>('GET', '/contracts?' + new URLSearchParams({ limit: '5', ...(branchId ? { branchId } : {}) }), { token }),
      call<Collections>('GET', '/payments/collections?' + params.toString(), { token }),
    ]);
    expect(dashboard.status).toBe(200);
    expect(dashboard.data.date).toBe(date);
    expect(dashboard.data.collections).toEqual({ total: collections.data.total, count: collections.data.count });
    expect(dashboard.data.overdue).toEqual(overdue.data);
    expect(dashboard.data.payments.map((payment) => payment._id)).toEqual(payments.data.items.map((payment) => payment._id));
    expect(dashboard.data.contracts.map((contract) => contract._id)).toEqual(contracts.data.items.map((contract) => contract._id));
    return dashboard.data;
  }

  test('matches all four existing endpoints, including voids and overdue installments', async () => {
    const first = await sell(firstBranch, 20_000);
    await sell(secondBranch, 0);
    await Installment.updateOne(
      { orgId: new Types.ObjectId(shop.session.org._id), contractId: new Types.ObjectId(first._id), number: 1 },
      { $set: { dueDate: addDays(todayInShops(), -6) } },
    );
    const paid = await call<Payment>('POST', '/contracts/' + first._id + '/payments', {
      token: shop.token,
      body: { branchId: firstBranch, amount: 10_000, method: 'cash' },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    expect(paid.status).toBe(201);
    const voided = await call<Payment>('POST', '/payments/' + paid.data._id + '/void', {
      token: shop.token,
      body: { reason: 'Incorrect entry' },
    });
    expect(voided.status).toBe(200);
    const snapshot = await compare(shop.token);
    expect(snapshot.collections.total).toBe(20_000);
    expect(snapshot.payments.some((item) => item.voidedAt !== null)).toBe(true);
    expect(snapshot.overdue.some((account) => account.contractId === first._id)).toBe(true);
    expect(snapshot.contracts).toHaveLength(2);
  });

  test('tenant/branch scope is enforced, including the requested branch filter', async () => {
    const first = await compare(shop.token, firstBranch);
    expect(first.contracts).toHaveLength(1);
    const second = await compare(shop.token, secondBranch);
    expect(second.contracts).toHaveLength(1);

    const staff = await addMember(shop.token, 'staff', [firstBranch]);
    const visible = await compare(staff.token);
    expect(visible.contracts.map((contract) => contract._id)).toEqual(first.contracts.map((contract) => contract._id));
    expect((await call('GET', '/dashboard?date=' + todayInShops() + '&branchId=' + secondBranch, { token: staff.token })).status).toBe(403);

    const elsewhere = await signupOrg('Other retailer');
    const isolated = await compare(elsewhere.token);
    expect(isolated.contracts).toEqual([]);
    expect(isolated.payments).toEqual([]);
    expect(isolated.overdue).toEqual([]);
    expect(isolated.collections.total).toBe(0);
  });

  test('requires authentication and valid dashboard query parameters', async () => {
    expect((await call('GET', '/dashboard?date=' + todayInShops())).status).toBe(401);
    expect((await call('GET', '/dashboard', { token: shop.token })).status).toBe(400);
    expect((await call('GET', '/dashboard?date=invalid', { token: shop.token })).status).toBe(400);
  });
});
