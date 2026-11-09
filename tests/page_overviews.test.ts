import { afterEach, expect, spyOn, test } from 'bun:test';
import { Types } from 'mongoose';
import { signAccessToken } from '../src/lib/jwt';
import { User } from '../src/models/user';
import { Customer } from '../src/models/customer';
import { Contract } from '../src/models/contract';
import { Payment } from '../src/models/payment';
import { Branch } from '../src/models/branch';
import { call } from './api';

const orgId = new Types.ObjectId();
const branchId = new Types.ObjectId();
const customerId = new Types.ObjectId();
const userId = new Types.ObjectId();
const mocks: { mockRestore(): void }[] = [];
afterEach(() => { mocks.forEach((mock) => mock.mockRestore()); mocks.length = 0; });
async function authenticate(role: 'owner' | 'staff' = 'owner') {
  mocks.push(spyOn(User, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({
    _id: userId, orgId, branchIds: [branchId], role, active: true, tokenVersion: 1,
  }) }) } as unknown as ReturnType<typeof User.findById>));
  return signAccessToken({ sub: String(userId), org: String(orgId), ver: 1 });
}
function paged(rows: unknown[]) {
  return { populate() { return this; }, lean() { return this; }, where() { return this; }, sort() { return this; }, limit: async () => rows };
}
for (const path of ['/payments/overview?date=2026-11-09', `/customers/${customerId}/overview`, '/users/overview']) {
  test(`${path} requires authentication`, async () => expect((await call('GET', path)).status).toBe(401));
}
test('customer overview returns profile and a bounded cursor page with organization scope', async () => {
  const token = await authenticate('staff');
  const ids = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
  const profile = { _id: customerId, fullName: 'Buyer', homeBranch: null };
  const customer = spyOn(Customer, 'findOne').mockReturnValue({ populate: () => ({ lean: async () => profile }) } as unknown as ReturnType<typeof Customer.findOne>);
  const contracts = spyOn(Contract, 'find').mockReturnValue(paged(ids.map((_id) => ({ _id }))) as unknown as ReturnType<typeof Contract.find>);
  mocks.push(customer, contracts);
  const res = await call<{ customer: typeof profile; contracts: { items: unknown[]; nextCursor: string } }>('GET', `/customers/${customerId}/overview?limit=2`, { token });
  expect(res.status).toBe(200);
  expect(res.data.customer.fullName).toBe('Buyer');
  expect(res.data.contracts.items).toHaveLength(2);
  expect(res.data.contracts.nextCursor).toBe(String(ids[1]));
  expect(contracts.mock.calls[0]![0] as unknown).toEqual({ orgId, customerId });
  expect(customer.mock.calls[0]![0] as unknown).toEqual({ _id: customerId, orgId });
});
test('payments overview scopes receipts and full-day non-void totals independently of cursor', async () => {
  const token = await authenticate('staff');
  const find = spyOn(Payment, 'find').mockReturnValue(paged([]) as unknown as ReturnType<typeof Payment.find>);
  const aggregate = spyOn(Payment, 'aggregate').mockResolvedValue([{ total: [{ total: 25000, count: 2 }], byMethod: [], byStaff: [] }]);
  mocks.push(find, aggregate);
  const res = await call<{ items: unknown[]; collections: { total: number; count: number } }>('GET', `/payments/overview?date=2026-11-09&cursor=${new Types.ObjectId()}`, { token });
  expect(res.status).toBe(200);
  expect(res.data).toMatchObject({ items: [], collections: { total: 25000, count: 2 } });
  expect(find.mock.calls[0]![0] as unknown).toEqual({ orgId, branchId: { $in: [branchId] }, receivedOn: '2026-11-09' });
  expect(aggregate.mock.calls[0]![0]?.[0]).toEqual({ $match: { orgId, branchId: { $in: [branchId] }, receivedOn: '2026-11-09', voidedAt: null } });
});
test('payments overview rejects foreign branch and invalid date before reading', async () => {
  const token = await authenticate('staff');
  const find = spyOn(Payment, 'find'); mocks.push(find);
  expect((await call('GET', `/payments/overview?date=2026-11-09&branchId=${new Types.ObjectId()}`, { token })).status).toBe(403);
  expect((await call('GET', '/payments/overview?date=bad', { token })).status).toBe(400);
  expect(find).not.toHaveBeenCalled();
});
test('team overview remains owner-only', async () => {
  const token = await authenticate('staff');
  const find = spyOn(Branch, 'find'); mocks.push(find);
  expect((await call('GET', '/users/overview', { token })).status).toBe(403);
  expect(find).not.toHaveBeenCalled();
});
test('team overview returns members and branch labels in one response', async () => {
  const token = await authenticate();
  const users = spyOn(User, 'find').mockReturnValue({ sort: () => ({ lean: async () => [{ fullName: 'Staff' }] }) } as unknown as ReturnType<typeof User.find>);
  const branches = spyOn(Branch, 'find').mockReturnValue({ sort: () => ({ lean: async () => [{ name: 'Branch', active: false }] }) } as unknown as ReturnType<typeof Branch.find>);
  mocks.push(users, branches);
  const res = await call('GET', '/users/overview', { token });
  expect(res.status).toBe(200);
  expect(res.data).toEqual({ members: [{ fullName: 'Staff' }], branches: [{ name: 'Branch', active: false }] });
  expect(users.mock.calls[0]![0] as unknown).toEqual({ orgId });
  expect(branches.mock.calls[0]![0] as unknown).toEqual({ orgId });
});
