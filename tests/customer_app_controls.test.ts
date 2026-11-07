import { afterEach, expect, spyOn, test } from 'bun:test';
import { Types } from 'mongoose';
import { env } from '../src/config/env';
import { signCustomerToken } from '../src/lib/customer_session';
import { CustomerAccount } from '../src/models/customer_account';
import { call } from './api';

const previous = { CUSTOMER_APP_MAINTENANCE: env.CUSTOMER_APP_MAINTENANCE, CUSTOMER_APP_MIN_VERSION_CODE: env.CUSTOMER_APP_MIN_VERSION_CODE };
afterEach(() => Object.assign(env, previous));

test('public config remains reachable during maintenance and customer auth is gated', async () => {
  env.CUSTOMER_APP_MAINTENANCE = true;
  const config = await call('GET', '/customer-app/config');
  expect(config.status).toBe(200); expect(config.data).toMatchObject({ maintenance: true });
  const response = await call('POST', '/customer-app/auth/start', { body: { phone: '03001234567' } });
  expect(response.status).toBe(503); expect(response.error?.code).toBe('MAINTENANCE_MODE');
});

test('minimum version gate rejects outdated clients before authentication', async () => {
  env.CUSTOMER_APP_MIN_VERSION_CODE = 100;
  const result = await call('GET', '/customer-app/overview');
  expect(result.status).toBe(426); expect(result.error?.code).toBe('CLIENT_UPDATE_REQUIRED');
  expect((await call('GET', '/customer-app/config')).status).toBe(200);
  expect((await call('GET', '/customer-app/overview', { headers: { 'X-Customer-App-Version': '100' } })).status).toBe(401);
  expect((await call('GET', '/customer-app/overview', { headers: { 'X-Customer-App-Version': 'invalid' } })).status).toBe(400);
});

test('deletion requires customer authentication even during maintenance', async () => {
  env.CUSTOMER_APP_MAINTENANCE = true;
  expect((await call('DELETE', '/customer-app/account')).status).toBe(401);
});

test('deletion is scoped to the active customer session and does not issue business-record deletes', async () => {
  env.CUSTOMER_APP_MAINTENANCE = true;
  const claims = { sub: new Types.ObjectId().toHexString(), ver: 2, sid: crypto.randomUUID() };
  const token = await signCustomerToken(claims, new Date(Date.now() + 60_000));
  const deletion = spyOn(CustomerAccount, 'deleteOne').mockResolvedValue({ acknowledged: true, deletedCount: 1 });
  try {
    const result = await call('DELETE', '/customer-app/account', { token });
    expect(result.status).toBe(200); expect(result.data).toEqual({ ok: true });
    const filter = deletion.mock.calls[0]![0] as unknown as { _id: Types.ObjectId; tokenVersion: number; sessions: unknown };
    expect(String(filter._id)).toBe(claims.sub); expect(filter.tokenVersion).toBe(2);
    expect(filter.sessions).toMatchObject({ $elemMatch: { id: claims.sid } });
  } finally { deletion.mockRestore(); }
});

test('revoked sessions cannot delete an existing app identity', async () => {
  const claims = { sub: new Types.ObjectId().toHexString(), ver: 1, sid: crypto.randomUUID() };
  const token = await signCustomerToken(claims, new Date(Date.now() + 60_000));
  const deletion = spyOn(CustomerAccount, 'deleteOne').mockResolvedValue({ acknowledged: true, deletedCount: 0 });
  const exists = spyOn(CustomerAccount, 'exists').mockResolvedValue({ _id: new Types.ObjectId(claims.sub) });
  try { expect((await call('DELETE', '/customer-app/account', { token })).status).toBe(401); }
  finally { deletion.mockRestore(); exists.mockRestore(); }
});

test('a lost successful deletion response can be retried safely', async () => {
  const token = await signCustomerToken({ sub: new Types.ObjectId().toHexString(), ver: 1, sid: crypto.randomUUID() }, new Date(Date.now() + 60_000));
  const deletion = spyOn(CustomerAccount, 'deleteOne').mockResolvedValue({ acknowledged: true, deletedCount: 0 });
  const exists = spyOn(CustomerAccount, 'exists').mockResolvedValue(null);
  try { expect((await call('DELETE', '/customer-app/account', { token })).status).toBe(200); }
  finally { deletion.mockRestore(); exists.mockRestore(); }
});
