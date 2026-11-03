import { beforeAll, describe, expect, test } from 'bun:test';
import type { Branch } from '@shop/shared';
import { call, prepareDatabase, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('branches', () => {
  beforeAll(prepareDatabase);

  test('the owner adds and edits branches', async () => {
    const owner = await signupOrg();
    const created = await call<Branch>('POST', '/branches', {
      token: owner.token,
      body: { name: 'Gulberg', phone: '042 35761234', address: 'Main Boulevard' },
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ name: 'Gulberg', phone: '042 35761234', active: true, orgId: owner.session.org._id });
    expect(created.data).not.toHaveProperty('__v');

    // Renaming must not touch fields that weren't sent.
    const renamed = await call<Branch>('PATCH', `/branches/${created.data._id}`, { token: owner.token, body: { name: 'Gulberg III' } });
    expect(renamed.data).toMatchObject({ _id: created.data._id, name: 'Gulberg III', phone: '042 35761234', address: 'Main Boulevard' });
  });

  test('the last active branch cannot be deactivated', async () => {
    const owner = await signupOrg();
    const main = owner.session.branches[0]._id;
    const res = await call('PATCH', `/branches/${main}`, { token: owner.token, body: { active: false } });
    expect(res.status).toBe(409);

    const second = await call<Branch>('POST', '/branches', { token: owner.token, body: { name: 'Saddar' } });
    expect((await call('PATCH', `/branches/${second.data._id}`, { token: owner.token, body: { active: false } })).status).toBe(200);
  });
});
