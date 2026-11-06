import { beforeAll, describe, expect, test } from 'bun:test';
import { addDays, DEVICE_ADMIN_COMPONENT, todayInShops, type Contract, type ContractWithSchedule, type Customer, type DeviceCheckin, type DeviceCommand, type DeviceCredential, type Device as DeviceDoc, type EnrollmentTicket } from '@shop/shared';
import { Types } from 'mongoose';
import { Device } from '../src/models/device';
import { call, newCustomer, prepareDatabase, randomImei, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('device API (Phase 2)', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>;
  let branch: string;
  let customer: Customer;

  const makeDevice = async () =>
    (await call<DeviceDoc>('POST', '/devices', { token: shop.token, body: { branchId: branch, brand: 'Oppo', model: 'A18', imeis: [randomImei()] } })).data;

  const sell = async (deviceId: string) =>
    (
      await call<Contract>('POST', '/contracts', {
        token: shop.token,
        body: { branchId: branch, customerId: customer._id, deviceId, cashPrice: 300_000, downPayment: 0, markupPercent: 0, count: 3, frequency: 'monthly', firstDueDate: addDays(todayInShops(), 1) },
      })
    ).data;

  /** A sold, enrolled phone: returns its id and the credential the app would store. */
  async function enrolledPhone() {
    const device = await makeDevice();
    await sell(device._id);
    const ticket = (await call<EnrollmentTicket>('POST', `/devices/${device._id}/enrollment`, { token: shop.token })).data;
    const credential = (await call<DeviceCredential>('POST', '/device/enroll', { body: { token: ticket.token } })).data;
    return { deviceId: device._id, token: credential.token };
  }

  const checkin = (token: string, body: Record<string, unknown> = {}) => call<DeviceCheckin>('POST', '/device/checkin', { headers: { Authorization: `Bearer ${token}` }, body });
  const ack = (token: string, id: string, result: 'applied' | 'failed') => call('POST', `/device/commands/${id}/ack`, { headers: { Authorization: `Bearer ${token}` }, body: { result } });
  const lock = (contractId: string) => call('POST', `/contracts/${contractId}/lock`, { token: shop.token, body: { reason: 'Overdue test lock' } });

  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
    branch = shop.session.branches[0]._id;
    customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(branch) })).data;
  });

  test('a phone must be sold before it can be enrolled', async () => {
    const device = await makeDevice();
    const res = await call('POST', `/devices/${device._id}/enrollment`, { token: shop.token });
    expect(res.status).toBe(409);
  });

  test('the enrolment ticket is a complete Android provisioning QR carrying the token', async () => {
    const device = await makeDevice();
    await sell(device._id);
    const ticket = (await call<EnrollmentTicket>('POST', `/devices/${device._id}/enrollment`, { token: shop.token })).data;

    expect(ticket.payload).toEqual({
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': DEVICE_ADMIN_COMPONENT,
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': 'https://downloads.example.invalid/qist-device.apk',
      'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': 'A'.repeat(43),
      'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
      'android.app.extra.PROVISIONING_SKIP_EDUCATION_SCREENS': true,
      'android.app.extra.PROVISIONING_TIME_ZONE': 'Asia/Karachi',
      'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { enrollToken: ticket.token },
    });
  });

  test('enrol redeems the one-time token for a credential, once', async () => {
    const device = await makeDevice();
    await sell(device._id);
    const ticket = (await call<EnrollmentTicket>('POST', `/devices/${device._id}/enrollment`, { token: shop.token })).data;
    expect(ticket.token).toContain(device._id);

    const first = await call<DeviceCredential>('POST', '/device/enroll', { body: { token: ticket.token } });
    expect(first.status).toBe(201);
    expect(first.data.deviceId).toBe(device._id);

    // The token is spent: a replay is refused.
    const replay = await call('POST', '/device/enroll', { body: { token: ticket.token } });
    expect(replay.status).toBe(401);
  });

  test('enrol refuses a forged or expired token', async () => {
    expect((await call('POST', '/device/enroll', { body: { token: `${new Types.ObjectId()}.deadbeef` } })).status).toBe(401);

    const device = await makeDevice();
    await sell(device._id);
    const ticket = (await call<EnrollmentTicket>('POST', `/devices/${device._id}/enrollment`, { token: shop.token })).data;
    await Device.updateOne({ _id: new Types.ObjectId(device._id), orgId: new Types.ObjectId(shop.session.org._id) }, { $set: { 'enrollToken.expiresAt': new Date(Date.now() - 1000) } });
    expect((await call('POST', '/device/enroll', { body: { token: ticket.token } })).status).toBe(401);
  });

  test('check-in needs the device credential', async () => {
    expect((await call('POST', '/device/checkin', { body: {} })).status).toBe(401);
    expect((await checkin('not.a-real-token')).status).toBe(401);
  });

  test('lock screens carry the current retailer accounts and branch address, excluding disabled methods', async () => {
    const wallet = { id: crypto.randomUUID(), kind: 'easypaisa' as const, enabled: true, accountTitle: 'Shop Account', accountNumber: '03001234567' };
    expect((await call('PATCH', '/org/payment-methods', { token: shop.token, body: { paymentMethods: [wallet, { id: crypto.randomUUID(), kind: 'cash', enabled: false }] } })).status).toBe(200);
    await call('PATCH', `/branches/${branch}`, { token: shop.token, body: { address: 'Main Road' } });
    const phone = await enrolledPhone();
    const response = await checkin(phone.token);
    expect(response.status).toBe(200);
    expect(response.data.lockScreen.paymentMethods).toEqual([wallet]);
    expect(response.data.lockScreen.branchAddress).toBe('Main Road');
    expect(response.data.lockScreen.retailerName).toBe(shop.session.org.name);
  });

  test('a fresh phone checks in with no commands and an unlocked screen', async () => {
    const phone = await enrolledPhone();
    const res = await checkin(phone.token, { appVersion: '1.0.0' });
    expect(res.status).toBe(200);
    expect(res.data.lockState).toBe('unlocked');
    expect(res.data.commands).toHaveLength(0);
    expect(res.data.lockScreen.branchName).toBeTruthy();
  });

  test('a lock reaches the phone on check-in, which acknowledges it', async () => {
    const device = await makeDevice();
    const contract = await sell(device._id);
    const ticket = (await call<EnrollmentTicket>('POST', `/devices/${device._id}/enrollment`, { token: shop.token })).data;
    const token = (await call<DeviceCredential>('POST', '/device/enroll', { body: { token: ticket.token } })).data.token;

    await lock(contract._id);

    const delivered = await checkin(token);
    expect(delivered.data.commands).toHaveLength(1);
    expect(delivered.data.commands[0].type).toBe('lock');

    const acked = await call<DeviceCommand>('POST', `/device/commands/${delivered.data.commands[0]._id}/ack`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { result: 'applied' },
    });
    expect(acked.status).toBe(200);
    expect(acked.data.status).toBe('acknowledged');
    const detail = await call<ContractWithSchedule>('GET', `/contracts/${contract._id}`, { token: shop.token });
    expect(detail.data.deviceLockState).toBe('locked');

    const after = await checkin(token);
    expect(after.data.lockState).toBe('locked');
    expect(after.data.lockScreen.locked).toBe(true);
    expect(after.data.commands).toHaveLength(0);
  });

  test('a failed command is recorded and leaves the phone unlocked', async () => {
    const device = await makeDevice();
    const contract = await sell(device._id);
    const ticket = (await call<EnrollmentTicket>('POST', `/devices/${device._id}/enrollment`, { token: shop.token })).data;
    const token = (await call<DeviceCredential>('POST', '/device/enroll', { body: { token: ticket.token } })).data.token;
    await lock(contract._id);
    const delivered = await checkin(token);
    await ack(token, delivered.data.commands[0]._id, 'failed');
    const after = await checkin(token);
    expect(after.data.lockState).toBe('unlocked');
    expect(after.data.commands).toHaveLength(0);
  });

  test('revoking enrolment stops the phone checking in', async () => {
    const phone = await enrolledPhone();
    expect((await checkin(phone.token)).status).toBe(200);
    expect((await call('DELETE', `/devices/${phone.deviceId}/enrollment`, { token: shop.token })).status).toBe(200);
    expect((await checkin(phone.token)).status).toBe(401);
  });
});
