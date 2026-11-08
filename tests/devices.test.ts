import { beforeAll, describe, expect, test } from 'bun:test';
import type { Branch, Device, Page } from '@shop/shared';
import { addMember, call, prepareDatabase, randomImei, signupOrg } from './api';
import { hasDatabase } from './setup';

const newDevice = (branchId: string, overrides: Record<string, unknown> = {}) => ({
  branchId,
  brand: 'Samsung',
  model: 'Galaxy A15',
  imeis: [randomImei()],
  storage: '128 GB',
  color: 'Black',
  ...overrides,
});

describe.skipIf(!hasDatabase)('inventory', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>;
  let mainBranch: string;
  let secondBranch: string;

  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
    mainBranch = shop.session.branches[0]._id;
    secondBranch = (await call<Branch>('POST', '/branches', { token: shop.token, body: { name: 'Saddar' } })).data._id;
  });

  const addDevice = (token: string, body: Record<string, unknown>) => call<Device>('POST', '/devices', { token, body });

  test('IMEIs must pass the check-digit test and exist once per retailer, in either slot', async () => {
    const bad = await addDevice(shop.token, newDevice(mainBranch, { imeis: ['490154203237517'] }));
    expect(bad.status).toBe(400);

    const [imei1, imei2] = [randomImei(), randomImei()];
    const created = await addDevice(shop.token, newDevice(mainBranch, { imeis: [imei1, imei2] }));
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ imeis: [imei1, imei2], stockStatus: 'in_stock', branch: { _id: mainBranch, name: 'Main Branch' } });

    const reused = await addDevice(shop.token, newDevice(mainBranch, { imeis: [randomImei(), imei2] }));
    expect(reused.status).toBe(409);
    expect(reused.error?.details).toEqual({ fields: [{ path: 'imeis', message: 'Already registered' }] });
  });

  test('only owners set and see the cost price', async () => {
    const staff = await addMember(shop.token, 'staff', [mainBranch]);
    const byOwner = await addDevice(shop.token, newDevice(mainBranch, { costPrice: 4_500_000 }));
    expect(byOwner.data.costPrice).toBe(4_500_000);
    expect((await call<Device>('GET', `/devices/${byOwner.data._id}`, { token: shop.token })).data.costPrice).toBe(4_500_000);
    expect((await call<Device>('GET', `/devices/${byOwner.data._id}`, { token: staff.token })).data).not.toHaveProperty('costPrice');

    const byStaff = await addDevice(staff.token, newDevice(mainBranch, { costPrice: 100 }));
    expect(byStaff.data).not.toHaveProperty('costPrice');
    const ownerView = await call<Page<Device>>(`GET`, `/devices?q=${byStaff.data.imeis[0]}`, { token: shop.token });
    expect(ownerView.data.items[0].costPrice).toBeNull();

    const staffList = await call<Page<Device>>('GET', '/devices', { token: staff.token });
    expect(JSON.stringify(staffList.data)).not.toContain('costPrice');
  });

  test('people see and add stock only at the branches they work at', async () => {
    const staff = await addMember(shop.token, 'staff', [secondBranch]);
    const atMain = await addDevice(shop.token, newDevice(mainBranch));
    const atSecond = await addDevice(staff.token, newDevice(secondBranch));
    expect(atSecond.status).toBe(201);
    expect((await addDevice(staff.token, newDevice(mainBranch))).status).toBe(403);

    const staffIds = (await call<Page<Device>>('GET', '/devices', { token: staff.token })).data.items.map((d) => d._id);
    expect(staffIds).toContain(atSecond.data._id);
    expect(staffIds).not.toContain(atMain.data._id);
    expect((await call('GET', `/devices/${atMain.data._id}`, { token: staff.token })).status).toBe(404);
    expect((await call('GET', `/devices/${atSecond.data._id}`, { token: staff.token })).status).toBe(200);
    const otherShop = await signupOrg('Other Shop');
    expect((await call('GET', `/devices/${atSecond.data._id}`, { token: otherShop.token })).status).toBe(404);
    expect((await call('GET', `/devices?branchId=${mainBranch}`, { token: staff.token })).status).toBe(403);

    const ownerSecond = await call<Page<Device>>('GET', `/devices?branchId=${secondBranch}`, { token: shop.token });
    expect(ownerSecond.data.items.every((d) => d.branchId === secondBranch)).toBe(true);
  });

  test('search by IMEI or model, and filter by status', async () => {
    const device = (await addDevice(shop.token, newDevice(mainBranch, { brand: 'Infinix', model: 'Hot 40 Pro' }))).data;
    const search = async (query: string) =>
      (await call<Page<Device>>('GET', `/devices?${query}`, { token: shop.token })).data.items.map((d) => d._id);

    expect(await search(`q=${device.imeis[0].slice(0, 8)}`)).toContain(device._id);
    expect(await search('q=hot%2040')).toContain(device._id);
    expect(await search('status=in_stock&q=Infinix')).toContain(device._id);
    expect(await search('status=sold&q=Infinix')).not.toContain(device._id);
  });

  test('transfers: managers and owners move stock between branches they work at', async () => {
    const device = (await addDevice(shop.token, newDevice(mainBranch))).data;
    const staff = await addMember(shop.token, 'staff', [mainBranch, secondBranch]);
    const managerOfMain = await addMember(shop.token, 'manager', [mainBranch]);
    const transfer = (token: string, toBranchId: string) => call<Device>('POST', `/devices/${device._id}/transfer`, { token, body: { toBranchId } });

    expect((await transfer(staff.token, secondBranch)).status).toBe(403);
    expect((await transfer(managerOfMain.token, secondBranch)).status).toBe(403);
    expect((await transfer(shop.token, mainBranch)).status).toBe(400);

    const moved = await transfer(shop.token, secondBranch);
    expect(moved.status).toBe(200);
    expect(moved.data).toMatchObject({ branchId: secondBranch, branch: { name: 'Saddar' } });
  });

  test('editing changes only what was sent; only the owner deletes, and only stock', async () => {
    const staff = await addMember(shop.token, 'staff', [mainBranch]);
    const device = (await addDevice(shop.token, newDevice(mainBranch))).data;

    const edited = await call<Device>('PATCH', `/devices/${device._id}`, { token: staff.token, body: { color: 'Mint' } });
    expect(edited.data).toMatchObject({ color: 'Mint', model: device.model, imeis: device.imeis });

    expect((await call('DELETE', `/devices/${device._id}`, { token: staff.token })).status).toBe(403);
    expect((await call('DELETE', `/devices/${device._id}`, { token: shop.token })).status).toBe(200);
    expect((await call('PATCH', `/devices/${device._id}`, { token: shop.token, body: { color: 'Red' } })).status).toBe(404);
  });
});
