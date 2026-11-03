import { beforeAll, describe, expect, test } from 'bun:test';
import type { Session, User, UserWithTemporaryPassword } from '@shop/shared';
import { Types } from 'mongoose';
import { AuditLog } from '../src/models/audit_log';
import { addMember, call, prepareDatabase, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('team', () => {
  beforeAll(prepareDatabase);

  test('the owner adds staff with a temporary password they must change', async () => {
    const owner = await signupOrg();
    const staff = await addMember(owner.token, 'staff', [owner.session.branches[0]._id]);

    expect(staff.temporaryPassword).toMatch(/^[A-Za-z2-9]{12}$/);
    expect(staff.user).toMatchObject({ role: 'staff', active: true, mustChangePassword: true });
    expect(staff.user).not.toHaveProperty('passwordHash');
    expect(staff.user).not.toHaveProperty('tokenVersion');
    const me = await call<Session>('GET', '/me', { token: staff.token });
    expect(me.data.user.mustChangePassword).toBe(true);

    const team = await call<User[]>('GET', '/users', { token: owner.token });
    expect(JSON.stringify(team.data)).not.toContain('passwordHash');

    const audits = await AuditLog.countDocuments({ orgId: new Types.ObjectId(owner.session.org._id), action: 'user.created' });
    expect(audits).toBe(1);
  });

  test('members can only be given active branches of the same organization', async () => {
    const owner = await signupOrg();
    const other = await signupOrg('Other Shop');
    const res = await call('POST', '/users', {
      token: owner.token,
      body: { fullName: 'Bilal Ahmed', email: 'bilal.cross@example.com', role: 'staff', branchIds: [other.session.branches[0]._id] },
    });
    expect(res.status).toBe(400);
    expect(res.error?.details).toEqual({ fields: [{ path: 'branchIds', message: 'Unknown or inactive branch' }] });
  });

  test("the owner can't be deactivated or re-roled through the team", async () => {
    const owner = await signupOrg();
    const ownerId = owner.session.user._id;
    expect((await call('PATCH', `/users/${ownerId}/active`, { token: owner.token, body: { active: false } })).status).toBe(400);
    expect((await call('PATCH', `/users/${ownerId}`, { token: owner.token, body: { role: 'staff' } })).status).toBe(400);
  });

  test('deactivating a member signs them out at once and blocks sign-in', async () => {
    const owner = await signupOrg();
    const staff = await addMember(owner.token, 'staff', [owner.session.branches[0]._id]);
    expect((await call('GET', '/me', { token: staff.token })).status).toBe(200);

    const res = await call<User>('PATCH', `/users/${staff.user._id}/active`, { token: owner.token, body: { active: false } });
    expect(res.data.active).toBe(false);
    expect((await call('GET', '/me', { token: staff.token })).status).toBe(401);
    expect((await call('POST', '/auth/refresh', { cookie: staff.cookie })).status).toBe(401);

    const login = await call('POST', '/auth/login', { body: { email: staff.email, password: staff.temporaryPassword } });
    expect(login.status).toBe(403);
  });

  test('a new temporary password replaces the old one', async () => {
    const owner = await signupOrg();
    const staff = await addMember(owner.token, 'staff', [owner.session.branches[0]._id]);
    const issued = await call<UserWithTemporaryPassword>('POST', `/users/${staff.user._id}/temporary-password`, { token: owner.token });
    expect(issued.status).toBe(200);

    const loginWith = (password: string) => call('POST', '/auth/login', { body: { email: staff.email, password } });
    expect((await loginWith(staff.temporaryPassword)).status).toBe(401);
    expect((await loginWith(issued.data.temporaryPassword)).status).toBe(200);
  });
});
