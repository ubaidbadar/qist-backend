import { beforeAll, describe, expect, test } from 'bun:test';
import type { Org } from '@shop/shared';
import sharp from 'sharp';
import { addMember, call, prepareDatabase, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('atomic organization settings', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>;
  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
  });
  test('saves name and logo together and rejects a stale overwrite', async () => {
    const current = (await call<Org>('GET', '/org', { token: shop.token })).data;
    const logo = {
      contentType: 'image/png',
      data: (
        await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } })
          .png()
          .toBuffer()
      ).toString('base64'),
    };
    const saved = await call<Org>('PATCH', '/org/settings', {
      token: shop.token,
      body: { name: 'Updated Fixture Shop', logo, expectedUpdatedAt: current.updatedAt },
    });
    expect(saved.status).toBe(200);
    expect(saved.data.name).toBe('Updated Fixture Shop');
    expect(saved.data.logoUpdatedAt).toBeTruthy();
    const stale = await call('PATCH', '/org/settings', {
      token: shop.token,
      body: { name: 'Stale Change', logo: null, expectedUpdatedAt: current.updatedAt },
    });
    expect(stale.status).toBe(409);
    const actual = (await call<Org>('GET', '/org', { token: shop.token })).data;
    expect(actual.name).toBe(saved.data.name);
    expect(actual.logoUpdatedAt).toBe(saved.data.logoUpdatedAt);
  });
  test('ordinary staff cannot change organization settings', async () => {
    const staff = await addMember(shop.token, 'staff', [shop.session.branches[0]._id]);
    expect(
      (await call('PATCH', '/org/settings', { token: staff.token, body: { name: 'Unauthorized' } })).status,
    ).toBe(403);
  });
});
