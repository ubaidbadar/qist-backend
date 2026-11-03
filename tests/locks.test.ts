import { beforeAll, describe, expect, test } from 'bun:test';
import { addDays, todayInShops, type ContractWithSchedule, type Customer, type Device, type DeviceCommand, type OverdueAccount, type Page } from '@shop/shared';
import { Types } from 'mongoose';
import { withJobLease } from '../src/jobs/lease';
import { Installment } from '../src/models/installment';
import { addMember, call, newCustomer, prepareDatabase, randomImei, signupOrg } from './api';
import { hasDatabase } from './setup';

let shop!: Awaited<ReturnType<typeof signupOrg>>;

const JOB_SECRET = () => `Bearer ${process.env.INTERNAL_JOB_SECRET}`;
const runJob = (name: string, secret = JOB_SECRET()) => {
  const query = shop?.session?.org?._id ? `?orgId=${shop.session.org._id}` : '';
  return call<{ ran: boolean }>('POST', `/internal/jobs/${name}${query}`, { headers: { Authorization: secret } });
};

describe.skipIf(!hasDatabase)('lock engine', () => {
  let branch: string;
  let customer: Customer;

  /** Rs 3,000 in 3 × Rs 1,000; the first installment made `daysLate` days overdue. */
  async function overdueContract(daysLate: number) {
    const device = (await call<Device>('POST', '/devices', { token: shop.token, body: { branchId: branch, brand: 'Oppo', model: 'A18', imeis: [randomImei()] } })).data;
    const contract = (
      await call<ContractWithSchedule>('POST', '/contracts', {
        token: shop.token,
        body: { branchId: branch, customerId: customer._id, deviceId: device._id, cashPrice: 300_000, downPayment: 0, markupPercent: 0, count: 3, frequency: 'monthly', firstDueDate: addDays(todayInShops(), 1) },
      })
    ).data;
    await Installment.updateOne({ orgId: new Types.ObjectId(shop.session.org._id), contractId: new Types.ObjectId(contract._id), number: 1 }, { $set: { dueDate: addDays(todayInShops(), -daysLate) } });
    return contract;
  }

  const commandsOf = async (contractId: string) => (await call<Page<DeviceCommand>>('GET', `/commands?contractId=${contractId}`, { token: shop.token })).data.items;
  const setPolicy = (body: Record<string, unknown>) => call('PATCH', '/org/policy', { token: shop.token, body });
  const pay = (contractId: string, amount: number) =>
    call('POST', `/contracts/${contractId}/payments`, { token: shop.token, body: { branchId: branch, amount, method: 'cash' }, headers: { 'Idempotency-Key': crypto.randomUUID() } });

  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
    branch = shop.session.branches[0]._id;
    customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(branch) })).data;
  });

  test('jobs need the internal secret', async () => {
    expect((await runJob('overdue', 'Bearer wrong')).status).toBe(401);
    expect((await runJob('nonsense')).status).toBe(404);
  });

  test('the overdue job marks late installments and adds a late fee once', async () => {
    const contract = await overdueContract(10);
    await setPolicy({ lateFee: { enabled: true, amount: 20_000 } });
    expect((await runJob('overdue')).data.ran).toBe(true);
    await runJob('overdue');
    const after = (await call<ContractWithSchedule>('GET', `/contracts/${contract._id}`, { token: shop.token })).data;
    expect(after.installments[0]).toMatchObject({ status: 'overdue', lateFee: 20_000 });
    expect(after.lateFees).toBe(20_000);
    await setPolicy({ lateFee: { enabled: false } });
  });

  test('approval mode proposes a lock once; a manager approves it', async () => {
    const contract = await overdueContract(5);
    await runJob('auto-lock');
    await runJob('auto-lock');
    const [proposal, ...more] = await commandsOf(contract._id);
    expect(more).toEqual([]);
    expect(proposal).toMatchObject({ type: 'lock', status: 'proposed', source: 'auto', requestedByName: 'System' });

    const staff = await addMember(shop.token, 'staff', [branch]);
    expect((await call('POST', `/commands/${proposal._id}/approve`, { token: staff.token })).status).toBe(403);
    const approved = await call<DeviceCommand>('POST', `/commands/${proposal._id}/approve`, { token: shop.token });
    expect(approved.data).toMatchObject({ status: 'pending', decidedByName: 'Owner Person' });
  });

  test('automatic mode queues the lock straight away; grace days and the minimum are respected', async () => {
    await setPolicy({ lockPolicy: { mode: 'automatic' } });
    const late = await overdueContract(5);
    const withinGrace = await overdueContract(2);
    await runJob('auto-lock');
    expect((await commandsOf(late._id))[0]).toMatchObject({ type: 'lock', status: 'pending' });
    expect(await commandsOf(withinGrace._id)).toEqual([]);

    await setPolicy({ lockPolicy: { minOverdue: 200_000 } });
    const small = await overdueContract(9);
    await runJob('auto-lock');
    expect(await commandsOf(small._id)).toEqual([]);
    await setPolicy({ lockPolicy: { mode: 'approval', minOverdue: 50_000 } });
  });

  test('paying the overdue amount withdraws a waiting lock; paying off queues a release', async () => {
    const contract = await overdueContract(6);
    await call('POST', `/contracts/${contract._id}/lock`, { token: shop.token, body: { reason: 'Not answering calls' } });
    await pay(contract._id, 100_000);
    expect((await commandsOf(contract._id))[0]).toMatchObject({ type: 'lock', status: 'cancelled', decisionReason: 'Overdue amount paid' });

    await pay(contract._id, 200_000);
    expect((await commandsOf(contract._id))[0]).toMatchObject({ type: 'release', status: 'pending', source: 'payment' });
  });

  test('manual lock and unlock: one command at a time; unlocking withdraws a waiting lock', async () => {
    const contract = await overdueContract(1);
    const lock = (token = shop.token) => call('POST', `/contracts/${contract._id}/lock`, { token, body: { reason: 'Customer moved away' } });
    const unlock = () => call('POST', `/contracts/${contract._id}/unlock`, { token: shop.token, body: { reason: 'Paid in cash at home' } });

    const staff = await addMember(shop.token, 'staff', [branch]);
    expect((await lock(staff.token)).status).toBe(403);
    expect((await lock()).status).toBe(201);
    expect((await lock()).status).toBe(409);
    expect((await unlock()).status).toBe(200);
    expect((await commandsOf(contract._id))[0]).toMatchObject({ status: 'cancelled', decisionReason: 'Paid in cash at home' });
    expect((await unlock()).status).toBe(409);
  });

  test('a promise to pay pauses automatic locks and withdraws a proposal', async () => {
    const contract = await overdueContract(8);
    await runJob('auto-lock');
    expect((await commandsOf(contract._id))[0].status).toBe('proposed');
    await call('POST', `/contracts/${contract._id}/pause`, { token: shop.token, body: { until: addDays(todayInShops(), 3), reason: 'Will pay on salary day' } });
    expect((await commandsOf(contract._id))[0].status).toBe('cancelled');
    await runJob('auto-lock');
    expect((await commandsOf(contract._id))[0].status).toBe('cancelled');
  });

  test('the overdue list shows days late, amount and any waiting command', async () => {
    const contract = await overdueContract(12);
    await runJob('auto-lock');
    const list = (await call<OverdueAccount[]>('GET', '/locks/overdue', { token: shop.token })).data;
    const account = list.find((a) => a.contractId === contract._id);
    expect((await commandsOf(contract._id))[0].reason).toBe('12 days overdue, Rs 1,000 owed');
    expect(account).toMatchObject({ daysOverdue: 12, overdueAmount: 100_000, lockState: 'unlocked', openCommand: { type: 'lock', status: 'proposed' } });
    expect(list[0].daysOverdue).toBeGreaterThanOrEqual(list[list.length - 1].daysOverdue);
  });

  test('a job lease keeps a second run out while the first is running', async () => {
    let inner: boolean | undefined;
    const outer = await withJobLease('lease-test', async () => {
      inner = await withJobLease('lease-test', async () => undefined);
    });
    expect([outer, inner]).toEqual([true, false]);
    expect(await withJobLease('lease-test', async () => undefined)).toBe(true);
  });
});
