import { beforeAll, describe, expect, test } from 'bun:test';
import {
  addDays,
  todayInShops,
  type Contract,
  type Customer,
  type Device as DeviceDoc,
  type DeviceCheckin,
  type DeviceCredential,
  type EnrollmentTicket,
} from '@shop/shared';
import { Types } from 'mongoose';
import { call, newCustomer, prepareDatabase, randomImei, signupOrg } from './api';
import { hasDatabase } from './setup';
import { Device } from '../src/models/device';
import { DeviceRecovery } from '../src/models/device_recovery';
import { authorizeOrphanRelease, recoveryFromToken } from '../src/lib/device_recovery';

describe.skipIf(!hasDatabase)('surviving device-owner recovery (separate database)', () => {
  let shop: Awaited<ReturnType<typeof signupOrg>>;
  let branch: string;
  let customer: Customer;

  const createEnrolledPhone = async () => {
    const created = await call<DeviceDoc>('POST', '/devices', {
      token: shop.token,
      body: { branchId: branch, brand: 'Nokia', model: 'X20', imeis: [randomImei()] },
    });
    expect(created.status).toBe(201);
    const deviceId = created.data._id;
    const sold = await call<Contract>('POST', '/contracts', {
      token: shop.token,
      body: {
        branchId: branch, customerId: customer._id, deviceId,
        cashPrice: 300_000, downPayment: 0, markupPercent: 0, count: 3,
        frequency: 'monthly', firstDueDate: addDays(todayInShops(), 1),
      },
    });
    expect(sold.status).toBe(201);
    const ticket = await call<EnrollmentTicket>('POST', `/devices/${deviceId}/enrollment`, { token: shop.token });
    expect(ticket.status).toBe(201);
    const credential = await call<DeviceCredential>('POST', '/device/enroll', { body: { token: ticket.data.token } });
    expect(credential.status).toBe(201);
    return { deviceId, credential: credential.data.token };
  };

  const checkin = (credential: string, pushToken?: string) =>
    call<DeviceCheckin>('POST', '/device/checkin', {
      headers: { Authorization: `Bearer ${credential}` },
      body: pushToken === undefined ? {} : { pushToken },
    });

  beforeAll(async () => {
    await prepareDatabase();
    shop = await signupOrg();
    branch = shop.session.branches[0]._id;
    customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(branch) })).data;
  });

  test('an enrolled phone has a verifier in the separate recovery database', async () => {
    const phone = await createEnrolledPhone();
    const enrolled = await DeviceRecovery.findById(phone.deviceId).select('+secretHash +pushToken').lean();
    expect(enrolled?.status).toBe('active');
    expect(enrolled?.secretHash).toHaveLength(64);
    expect(enrolled?.secretHash).not.toEqual(phone.credential);
    expect(enrolled?.pushToken).toBe('');
    expect(await recoveryFromToken(phone.credential)).not.toBeNull();

    const pushed = await checkin(phone.credential, 'firebase-test-token');
    expect(pushed.status).toBe(200);
    const mirrored = await DeviceRecovery.findById(phone.deviceId).select('+pushToken').lean();
    expect(mirrored?.pushToken).toBe('firebase-test-token');
  });

  test('a verified orphan gets retryable 503, not permanent 401; bad credentials remain 401', async () => {
    const phone = await createEnrolledPhone();
    const device = await Device.findById(phone.deviceId).lean();
    expect(device).not.toBeNull();
    await Device.deleteOne({ _id: phone.deviceId, orgId: device!.orgId });

    const missing = await checkin(phone.credential);
    expect(missing.status).toBe(503);
    expect(missing.error?.code).toBe('SERVICE_UNAVAILABLE');

    const forged = await checkin(`${phone.deviceId}.${'A'.repeat(43)}`);
    expect(forged.status).toBe(401);
  });

  test('explicit SSH authorization delivers the existing release command and acknowledges it once', async () => {
    const phone = await createEnrolledPhone();
    await expect(authorizeOrphanRelease(new Types.ObjectId(phone.deviceId)))
      .rejects.toThrow('device still exists');

    const device = await Device.findById(phone.deviceId).lean();
    await Device.deleteOne({ _id: phone.deviceId, orgId: device!.orgId });

    const authorized = await authorizeOrphanRelease(new Types.ObjectId(phone.deviceId));
    expect(authorized?.status).toBe('release_requested');
    expect(authorized?.commandId).toBeDefined();

    const res = await checkin(phone.credential);
    expect(res.status).toBe(200);
    expect(res.data.commands).toEqual([{ _id: String(authorized?.commandId), type: 'release' }]);
    expect(res.data.lockState).toBe('unlocked');

    // Recovery credentials cannot authenticate to the customer's device sign-in APIs.
    const blocked = await call('GET', '/device/customer-auth/pending', {
      headers: { Authorization: `Bearer ${phone.credential}` },
    });
    expect(blocked.status).toBe(401);

    const ackUrl = `/device/commands/${authorized?.commandId}/ack`;
    const applied = await call('POST', ackUrl, {
      headers: { Authorization: `Bearer ${phone.credential}` },
      body: { result: 'applied' },
    });
    expect(applied.status).toBe(200);
    expect((await DeviceRecovery.findById(phone.deviceId).lean())?.status).toBe('released');

    // The APK retries this acknowledgement if Device Owner relinquish is delayed.
    expect((await call('POST', ackUrl, {
      headers: { Authorization: `Bearer ${phone.credential}` },
      body: { result: 'applied' },
    })).status).toBe(200);
    expect((await checkin(phone.credential)).status).toBe(401);
  });

  test('intentional portal revocation cannot be bypassed by the survival verifier', async () => {
    const phone = await createEnrolledPhone();
    expect((await call('DELETE', `/devices/${phone.deviceId}/enrollment`, { token: shop.token })).status).toBe(200);
    expect((await checkin(phone.credential)).status).toBe(401);
    expect((await DeviceRecovery.findById(phone.deviceId).lean())?.status).toBe('revoked');

    const device = await Device.findById(phone.deviceId).lean();
    await Device.deleteOne({ _id: phone.deviceId, orgId: device!.orgId });
    expect((await checkin(phone.credential)).status).toBe(401);
  });
});
