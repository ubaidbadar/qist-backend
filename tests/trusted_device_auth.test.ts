import { beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Types } from 'mongoose';
import type { Contract, Customer, Device as DeviceDoc, DeviceCredential, EnrollmentTicket } from '@shop/shared';
import { addDays, todayInShops } from '@shop/shared';
import { call, newCustomer, prepareDatabase, randomImei, randomMobile, signupOrg } from './api';
import { hasDatabase } from './setup';
import { DeviceSignin } from '../src/models/device_signin';
import { Device } from '../src/models/device';
import { Customer as CustomerModel } from '../src/models/customer';
import { CustomerAccount } from '../src/models/customer_account';
import { keyRegistrationPayload, signinHash, signinPayload, validSigninSignature } from '../src/lib/trusted_device_auth';

import fixture from './fixtures/trusted-signin.json';

test('Java-compatible canonical signature fixture rejects changed purpose and number', () => {
  const payload = signinPayload({ _id: fixture.requestId, ...fixture, expiresAt: new Date(fixture.expiresAt) }, fixture.deviceId, fixture.decision, fixture.number);
  expect(payload).toBe(fixture.payload);
  expect(validSigninSignature(fixture.publicKey, payload, fixture.signature)).toBe(true);
  expect(validSigninSignature(fixture.publicKey, payload.replace('remote', 'local'), fixture.signature)).toBe(false);
  expect(validSigninSignature(fixture.publicKey, payload.replace('074', '075'), fixture.signature)).toBe(false);
});

type Challenge = { requestId: string; kind: string; nonceHash: string; challenge: string; expiresAt: string };
const nonce = () => randomBytes(32).toString('base64url');
function key() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey, sign: (body: string) => sign('sha256', Buffer.from(body), pair.privateKey).toString('base64url') };
}
describe.skipIf(!hasDatabase)('trusted Locker authentication', () => {
  beforeAll(prepareDatabase);
  async function owner() {
    const shop = await signupOrg(); const branchId = shop.session.branches[0]._id; const phone = randomMobile();
    const customer = (await call<Customer>('POST', '/customers', { token: shop.token, body: newCustomer(branchId, { phone }) })).data;
    const device = (await call<DeviceDoc>('POST', '/devices', { token: shop.token, body: { branchId, brand: 'Test', model: 'Phone', imeis: [randomImei()] } })).data;
    const contract = await call<Contract>('POST', '/contracts', { token: shop.token, body: { branchId, customerId: customer._id, deviceId: device._id, cashPrice: 400000, downPayment: 100000, markupPercent: 0, count: 3, frequency: 'monthly', firstDueDate: addDays(todayInShops(), 10) } });
    expect(contract.status).toBe(201);
    const ticket = (await call<EnrollmentTicket>('POST', `/devices/${device._id}/enrollment`, { token: shop.token })).data;
    const credential = (await call<DeviceCredential>('POST', '/device/enroll', { body: { token: ticket.token } })).data;
    const signing = key();
    const register = await call('POST', '/device/customer-auth/key', { token: credential.token, body: { publicKey: signing.publicKey, signature: signing.sign(keyRegistrationPayload(device._id, signinHash(signing.publicKey))) } });
    expect(register.status).toBe(200);
    return { shop, device, credential, signing, phone };
  }
  async function local(o: Awaited<ReturnType<typeof owner>>) {
    const n = nonce();
    const created = await call<Challenge>('POST', '/customer-app/auth/device/local', { body: { nonce: n } });
    expect(created.status).toBe(201);
    const meta = await call<Challenge>('POST', '/device/customer-auth/local', { token: o.credential.token, body: { requestId: created.data.requestId, nonce: n } });
    expect(meta.status).toBe(200);
    return { n, meta: meta.data };
  }
  function decision(o: Awaited<ReturnType<typeof owner>>, meta: Challenge, decision: 'approve' | 'deny', number = '', signer = o.signing) {
    const signature = signer.sign(signinPayload({ _id: meta.requestId, ...meta, expiresAt: new Date(meta.expiresAt) }, o.device._id, decision, number));
    return call('POST', '/device/customer-auth/decide', { token: o.credential.token, body: { requestId: meta.requestId, decision, ...(number ? { number } : {}), signature } });
  }
  const claim = (requestId: string, n: string) => call<{ state: string; ticket: string }>('POST', '/customer-app/auth/device/claim', { body: { requestId, nonce: n } });

  test('requires a valid immutable key, signed proof and matching nonce; grants first password setup only', async () => {
    const o = await owner(); const proof = await local(o);
    expect((await call('POST', '/device/customer-auth/issue', { token: o.credential.token, body: { nonce: proof.n } })).status).toBe(503);
    const replacement = key();
    expect((await call('POST', '/device/customer-auth/key', { token: o.credential.token, body: { publicKey: replacement.publicKey, signature: replacement.sign(keyRegistrationPayload(o.device._id, signinHash(replacement.publicKey))) } })).status).toBe(409);
    expect((await decision(o, proof.meta, 'approve', '', key())).status).toBe(401);
    expect((await decision(o, proof.meta, 'approve')).status).toBe(200);
    expect((await decision(o, proof.meta, 'approve')).status).toBe(401);
    expect((await claim(proof.meta.requestId, nonce())).status).toBe(401);
    const claims = await Promise.all([claim(proof.meta.requestId, proof.n), claim(proof.meta.requestId, proof.n)]);
    expect(claims.map((r) => r.status).sort()).toEqual([200, 401]);
    const grant = claims.find((r) => r.status === 200)!;
    const exchange = await call<{ next: string; setupToken: string; phone: string }>('POST', '/customer-app/auth/device/exchange', { body: { nonce: proof.n, ticket: grant.data.ticket } });
    expect(exchange.status).toBe(200); expect(exchange.data.next).toBe('password'); expect(exchange.data).not.toHaveProperty('accessToken');
    expect((await call('POST', '/customer-app/auth/device/exchange', { body: { nonce: proof.n, ticket: grant.data.ticket } })).status).toBe(401);
    const password = await call('POST', '/customer-app/auth/set-password', { body: { phone: exchange.data.phone, setupToken: exchange.data.setupToken, password: 'test-password-123' } });
    expect(password.status).toBe(200);
    const again = await local(o); await decision(o, again.meta, 'approve'); const second = await claim(again.meta.requestId, again.n);
    const session = await call<{ next: string; accessToken: string }>('POST', '/customer-app/auth/device/exchange', { body: { nonce: again.n, ticket: second.data.ticket } });
    expect(session.data.next).toBe('session'); expect(session.data.accessToken).toBeTruthy();
  });

  test('remote approval requires number matching; a push notification is never approval', async () => {
    const o = await owner(); const n = nonce();
    const remote = await call<Challenge & { number: string }>('POST', '/customer-app/auth/device/request', { body: { phone: o.phone, nonce: n } });
    expect(remote.status).toBe(201); expect((await claim(remote.data.requestId, n)).data.state).toBe('pending');
    const pending = await call<{ requests: Challenge[] }>('GET', '/device/customer-auth/pending', { token: o.credential.token });
    const meta = pending.data.requests.find((r) => r.requestId === remote.data.requestId)!;
    expect(meta).toBeTruthy(); expect(meta).not.toHaveProperty('number');
    expect((await decision(o, meta, 'approve', remote.data.number === '000' ? '001' : '000')).status).toBe(400);
    expect((await claim(meta.requestId, n)).data.state).toBe('pending');
    expect((await decision(o, meta, 'approve', remote.data.number)).status).toBe(200);
    expect((await claim(meta.requestId, n)).data.state).toBe('approved');
  });

  test('rejects grants after release, revocation, expiry or account deletion', async () => {
    const o = await owner(); const first = await local(o); await decision(o, first.meta, 'approve');
    await Device.updateOne({ _id: o.device._id, orgId: o.shop.session.org._id }, { $set: { stockStatus: 'released' } });
    expect((await claim(first.meta.requestId, first.n)).status).toBe(401);
    await Device.updateOne({ _id: o.device._id, orgId: o.shop.session.org._id }, { $set: { stockStatus: 'sold' } });
    const second = await local(o); await decision(o, second.meta, 'approve');
    const grant = await claim(second.meta.requestId, second.n);
    await CustomerAccount.deleteOne({ phone: o.phone });
    expect((await call('POST', '/customer-app/auth/device/exchange', { body: { nonce: second.n, ticket: grant.data.ticket } })).status).toBe(401);
    const third = await local(o); await DeviceSignin.updateOne({ _id: third.meta.requestId }, { $set: { expiresAt: new Date(0) } });
    expect((await decision(o, third.meta, 'approve')).status).toBe(401);
    const fourth = await local(o); await decision(o, fourth.meta, 'approve');
    await Device.updateOne({ _id: o.device._id, orgId: o.shop.session.org._id }, { $unset: { enrollment: 1 } });
    expect((await claim(fourth.meta.requestId, fourth.n)).status).toBe(401);
  });

  test('a different enrolled phone cannot sign another request; cancel and deny never grant sessions', async () => {
    const a = await owner(); const b = await owner(); const proof = await local(a);
    const forged = b.signing.sign(signinPayload({ _id: proof.meta.requestId, ...proof.meta, expiresAt: new Date(proof.meta.expiresAt) }, a.device._id, 'approve', ''));
    expect((await call('POST', '/device/customer-auth/decide', { token: b.credential.token, body: { requestId: proof.meta.requestId, decision: 'approve', signature: forged } })).status).toBe(401);
    expect((await decision(a, proof.meta, 'deny')).status).toBe(200); expect((await claim(proof.meta.requestId, proof.n)).data.state).toBe('denied');
    const next = await local(a);
    expect((await call('POST', '/customer-app/auth/device/cancel', { body: { requestId: next.meta.requestId, nonce: next.n } })).status).toBe(200);
    expect((await decision(a, next.meta, 'approve')).status).toBe(401);
    expect(await CustomerAccount.exists({ phone: a.phone })).toBeNull();
    expect(await DeviceSignin.exists({ _id: new Types.ObjectId(next.meta.requestId), state: 'cancelled' })).toBeTruthy();
  });
  test('reenrollment, reassignment and token-version changes invalidate outstanding proofs', async () => {
    const o = await owner(); const original = await local(o); await decision(o, original.meta, 'approve');
    const grant = await claim(original.meta.requestId, original.n);
    await CustomerModel.updateOne({ _id: (await CustomerModel.findOne({ orgId: o.shop.session.org._id, phone: o.phone }))!._id, orgId: o.shop.session.org._id }, { $set: { phone: randomMobile() } });
    expect((await call('POST', '/customer-app/auth/device/exchange', { body: { nonce: original.n, ticket: grant.data.ticket } })).status).toBe(401);
    const n = await owner(); const pending = await local(n); await decision(n, pending.meta, 'approve');
    await CustomerAccount.updateOne({ phone: n.phone }, { $inc: { tokenVersion: 1 } });
    expect((await claim(pending.meta.requestId, pending.n)).status).toBe(401);
    const replacement = await local(n); await decision(n, replacement.meta, 'approve');
    await Device.updateOne({ _id: n.device._id, orgId: n.shop.session.org._id }, { $set: { 'enrollment.secretHash': signinHash(nonce()) }, $unset: { 'enrollment.authKeyId': 1, 'enrollment.authPublicKey': 1 } });
    expect((await claim(replacement.meta.requestId, replacement.n)).status).toBe(401);
    expect((await decision(n, replacement.meta, 'approve')).status).toBe(401);
  });

  test('first-password proof cannot survive release or overwrite an existing password', async () => {
    const o = await owner(); const proof = await local(o); await decision(o, proof.meta, 'approve');
    const grant = await claim(proof.meta.requestId, proof.n);
    const setup = await call<{ setupToken: string; phone: string }>('POST', '/customer-app/auth/device/exchange', { body: { nonce: proof.n, ticket: grant.data.ticket } });
    await Device.updateOne({ _id: o.device._id, orgId: o.shop.session.org._id }, { $set: { stockStatus: 'released' } });
    expect((await call('POST', '/customer-app/auth/set-password', { body: { phone: setup.data.phone, setupToken: setup.data.setupToken, password: 'test-password-123' } })).status).toBe(401);
    expect((await CustomerAccount.findOne({ phone: o.phone }).select('+passwordHash').lean())?.passwordHash).toBeNull();
  });

  test('number guesses and concurrent remote requests are bounded; unknown phone remains private', async () => {
    const o = await owner(); const n = nonce();
    const requests = await Promise.all(Array.from({ length: 6 }, () => call<Challenge & { number: string }>('POST', '/customer-app/auth/device/request', { body: { phone: o.phone, nonce: n } })));
    expect(requests.filter((r) => r.status === 201)).toHaveLength(1);
    expect(requests.filter((r) => r.status === 429)).toHaveLength(5);
    const remote = requests.find((r) => r.status === 201)!;
    const pending = await call<{ requests: Challenge[] }>('GET', '/device/customer-auth/pending', { token: o.credential.token });
    const meta = pending.data.requests.find((r) => r.requestId === remote.data.requestId)!;
    const wrong = remote.data.number === '000' ? '001' : '000';
    for (let attempt = 0; attempt < 5; attempt++) expect((await decision(o, meta, 'approve', wrong)).status).toBe(400);
    expect((await decision(o, meta, 'approve', remote.data.number)).status).toBe(401);
    expect((await call<{ requests: Challenge[] }>('GET', '/device/customer-auth/pending', { token: o.credential.token })).data.requests).toHaveLength(0);
    expect((await claim(meta.requestId, n)).data.state).toBe('pending');
    const unknown = await call<Challenge & { number: string }>('POST', '/customer-app/auth/device/request', { body: { phone: randomMobile(), nonce: nonce() } });
    expect(unknown.status).toBe(201); expect(Object.keys(unknown.data).sort()).toEqual(['expiresAt', 'number', 'requestId']);
    expect(unknown.data.number).toMatch(/^\d{3}$/);
  });

});
