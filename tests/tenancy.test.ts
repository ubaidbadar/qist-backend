import { beforeAll, describe, expect, test } from 'bun:test';
import type { Branch, Me } from '@shop/shared';
import { addMember, call, prepareDatabase, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('tenant and branch isolation', () => {
  let shopA: Awaited<ReturnType<typeof signupOrg>>;
  let shopB: Awaited<ReturnType<typeof signupOrg>>;
  let secondBranchA: Branch;

  beforeAll(async () => {
    await prepareDatabase();
    shopA = await signupOrg('Shop A');
    shopB = await signupOrg('Shop B');
    secondBranchA = (await call<Branch>('POST', '/branches', { token: shopA.token, body: { name: 'Second' } })).data;
  });

  test("an organization never sees or changes another organization's data", async () => {
    const branchB = shopB.session.branches[0]._id;
    const listed = await call<Branch[]>('GET', '/branches', { token: shopA.token });
    expect(listed.data.map((branch) => branch._id)).not.toContain(branchB);

    expect((await call('PATCH', `/branches/${branchB}`, { token: shopA.token, body: { name: 'Taken over' } })).status).toBe(404);
    expect((await call('PATCH', `/users/${shopB.session.user._id}`, { token: shopA.token, body: { fullName: 'Taken over' } })).status).toBe(404);
    expect((await call<Me>('GET', '/me', { token: shopB.token })).data.branches[0]._id).toBe(branchB);
  });

  test('staff and managers see only their assigned branches; the owner sees all', async () => {
    const staff = await addMember(shopA.token, 'staff', [secondBranchA._id]);
    const staffBranches = await call<Branch[]>('GET', '/branches', { token: staff.token });
    expect(staffBranches.data.map((branch) => branch._id)).toEqual([secondBranchA._id]);
    expect((await call<Me>('GET', '/me', { token: staff.token })).data.branches.map((branch) => branch._id)).toEqual([secondBranchA._id]);

    const ownerBranches = await call<Branch[]>('GET', '/branches', { token: shopA.token });
    expect(ownerBranches.data).toHaveLength(2);
  });

  test('the server enforces the permission matrix: owner-only endpoints refuse managers and staff', async () => {
    const branchId = shopA.session.branches[0]._id;
    const manager = await addMember(shopA.token, 'manager', [branchId]);
    const staff = await addMember(shopA.token, 'staff', [branchId]);
    const ownerOnly: [string, string, unknown?][] = [
      ['GET', '/users'],
      ['POST', '/users', { fullName: 'New Person', email: 'new.person@example.com', role: 'staff', branchIds: [branchId] }],
      ['POST', '/branches', { name: 'Another' }],
      ['PATCH', `/branches/${branchId}`, { name: 'Renamed' }],
      ['PATCH', '/org', { name: 'Renamed Org' }],
    ];

    for (const { token } of [manager, staff]) {
      for (const [method, path, body] of ownerOnly) {
        expect({ method, path, status: (await call(method, path, { token, body })).status }).toEqual({ method, path, status: 403 });
      }
      for (const path of ['/me', '/org', '/branches']) {
        expect((await call('GET', path, { token })).status).toBe(200);
      }
    }
  });
});
