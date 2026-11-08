import { afterEach, expect, spyOn, test } from 'bun:test';
import { Types } from 'mongoose';
import { signAccessToken } from '../src/lib/jwt';
import { Device } from '../src/models/device';
import { User } from '../src/models/user';
import { call } from './api';

const orgId = new Types.ObjectId();
const branchId = new Types.ObjectId();
const deviceId = new Types.ObjectId();
const userId = new Types.ObjectId();
const mocks: { mockRestore(): void }[] = [];
afterEach(() => { mocks.forEach((mock) => mock.mockRestore()); mocks.length = 0; });
async function authenticate(role: 'owner' | 'staff' = 'owner') {
  mocks.push(spyOn(User, 'findById').mockReturnValue({ select: () => ({ lean: async () => ({
    _id: userId, orgId, branchIds: [branchId], role, active: true, tokenVersion: 1, fullName: 'Staff', email: 'staff@example.com',
  }) }) } as unknown as ReturnType<typeof User.findById>));
  return signAccessToken({ sub: String(userId), org: String(orgId), ver: 1 });
}
function lookup(value: unknown) {
  const select = spyOn(Device, 'findOne').mockReturnValue({ select: (fields: string) => {
    selected = fields;
    return { populate: (options: unknown) => { population = options; return { lean: async () => value }; } };
  } } as unknown as ReturnType<typeof Device.findOne>);
  mocks.push(select);
  return select;
}
let selected = '';
let population: unknown;

test('device detail requires staff authentication', async () => {
  const find = lookup(null);
  expect((await call('GET', `/devices/${deviceId}`)).status).toBe(401);
  expect(find).not.toHaveBeenCalled();
});
for (const role of ['owner', 'staff'] as const) test(`device detail retains ${role} scope and cost projection`, async () => {
  const token = await authenticate(role);
  const find = lookup({ _id: deviceId, model: 'Galaxy A15', stockStatus: 'sold' });
  const result = await call<{ _id: string; model: string }>('GET', `/devices/${deviceId}`, { token });
  expect(result.status).toBe(200);
  expect(result.data._id).toBe(String(deviceId));
  const filter = find.mock.calls[0]![0] as unknown as { _id: Types.ObjectId; orgId: Types.ObjectId; branchId?: { $in: Types.ObjectId[] } };
  expect(String(filter._id)).toBe(String(deviceId));
  expect(String(filter.orgId)).toBe(String(orgId));
  expect(filter.branchId?.$in.map(String)).toEqual(role === 'staff' ? [String(branchId)] : undefined);
  expect(selected).toBe(role === 'owner' ? '+costPrice' : '');
  expect(population).toEqual({ path: 'branch', select: 'name', match: { orgId } });
});
test('missing or inaccessible device returns the existing not-found response', async () => {
  const token = await authenticate('staff');
  lookup(null);
  const result = await call('GET', `/devices/${deviceId}`, { token });
  expect(result.status).toBe(404);
  expect(result.error?.message).toContain('Phone');
});
test('malformed device id is rejected before querying inventory', async () => {
  const token = await authenticate();
  const find = lookup(null);
  expect((await call('GET', '/devices/not-an-id', { token })).status).toBe(404);
  expect(find).not.toHaveBeenCalled();
});
