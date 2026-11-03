import { beforeAll, describe, expect, test } from 'bun:test';
import type { Me, Session } from '@shop/shared';
import { RefreshToken } from '../src/models/refresh_token';
import { call, PASSWORD, prepareDatabase, signupOrg, tokenFromLastEmail, uniqueEmail } from './api';
import { hasDatabase } from './setup';

const login = (email: string, password = PASSWORD) => call<Session>('POST', '/auth/login', { body: { email, password } });
const refresh = (cookie: string) => call<Session>('POST', '/auth/refresh', { cookie });
/** The refresh token document's _id, from the "<_id>.<secret>" cookie value. */
const tokenIdOf = (cookie: string) => cookie.slice('qist_refresh='.length).split('.')[0];

describe.skipIf(!hasDatabase)('auth', () => {
  beforeAll(prepareDatabase);

  test('signup creates the organization, its first branch and the owner, and signs the owner in', async () => {
    const email = uniqueEmail('owner');
    const res = await call<Session>('POST', '/auth/signup', {
      body: { orgName: 'Lahore Mobiles', branchName: 'Main Branch', fullName: 'Ayesha Khan', email, password: PASSWORD },
    });

    expect(res.status).toBe(201);
    expect(res.data.refreshToken).toBeDefined();
    expect(typeof res.data.refreshToken).toBe('string');
    expect(res.data.user).toMatchObject({ email, role: 'owner', emailVerifiedAt: null, mustChangePassword: false });
    expect(res.data.user).not.toHaveProperty('passwordHash');
    expect(res.data.user).not.toHaveProperty('tokenVersion');
    expect(res.data.org).toMatchObject({ name: 'Lahore Mobiles', status: 'active' });
    expect(res.data.branches).toHaveLength(1);
    expect(res.data.branches[0]).toMatchObject({ name: 'Main Branch', active: true, orgId: res.data.org._id });
    expect(res.rawCookie).toContain('HttpOnly');
    expect(res.rawCookie).toContain('Path=/api/v1/auth');
    expect(res.rawCookie).toContain('SameSite=Lax');
    expect(tokenFromLastEmail(email).length).toBeGreaterThan(20);
  });

  test('an email can only be registered once', async () => {
    const { email } = await signupOrg();
    const res = await call('POST', '/auth/signup', {
      body: { orgName: 'Copy', branchName: 'Main', fullName: 'Someone Else', email: email.toUpperCase(), password: PASSWORD },
    });
    expect(res.status).toBe(409);
    expect(res.error?.details).toEqual({ fields: [{ path: 'email', message: 'Already registered' }] });
  });

  test('a wrong password and an unknown email fail with the same message', async () => {
    const { email } = await signupOrg();
    const wrongPassword = await login(email, 'not the password');
    const unknownEmail = await login(uniqueEmail('nobody'));
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.error?.message).toBe(unknownEmail.error?.message);
  });

  test('protected routes need a valid access token', async () => {
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('GET', '/me', { token: 'not-a-jwt' })).status).toBe(401);
    const { token } = await signupOrg();
    expect((await call<Me>('GET', '/me', { token })).status).toBe(200);
  });

  test('refresh rotates the token; a concurrent reuse is tolerated, a late replay signs the user out everywhere', async () => {
    const { cookie: first } = await signupOrg();
    const second = (await refresh(first)).refreshCookie ?? '';
    expect(second).not.toBe(first);

    // Another tab presenting the just-rotated token: refused, but the session survives.
    expect((await refresh(first)).status).toBe(401);
    const third = (await refresh(second)).refreshCookie ?? '';
    expect(third).toStartWith('qist_refresh=');

    // The same replay long after rotation looks like a stolen token: every session of the user is revoked.
    await RefreshToken.updateOne({ _id: tokenIdOf(first) }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
    expect((await refresh(first)).status).toBe(401);
    expect((await refresh(third)).status).toBe(401);
  });

  test('a forged refresh cookie is refused', async () => {
    const { cookie } = await signupOrg();
    const forged = `qist_refresh=${tokenIdOf(cookie)}.not-the-secret`;
    expect((await refresh(forged)).status).toBe(401);
    expect((await refresh(cookie)).status).toBe(200);
  });

  test('refresh works with request body refreshToken or X-Refresh-Token header (cross-site fallback)', async () => {
    const { session } = await signupOrg();
    expect(session.refreshToken).toBeDefined();
    const token = session.refreshToken!;

    // Refresh via JSON body
    const bodyRes = await call<Session>('POST', '/auth/refresh', { body: { refreshToken: token } });
    expect(bodyRes.status).toBe(200);
    expect(bodyRes.data.refreshToken).toBeDefined();
    const nextToken = bodyRes.data.refreshToken!;
    expect(nextToken).not.toBe(token);

    // Refresh via X-Refresh-Token header
    const headerRes = await call<Session>('POST', '/auth/refresh', { headers: { 'X-Refresh-Token': nextToken } });
    expect(headerRes.status).toBe(200);
    expect(headerRes.data.refreshToken).toBeDefined();

    // Logout via body
    const logoutRes = await call('POST', '/auth/logout', { body: { refreshToken: headerRes.data.refreshToken } });
    expect(logoutRes.status).toBe(200);
    expect((await call('POST', '/auth/refresh', { body: { refreshToken: headerRes.data.refreshToken } })).status).toBe(401);
  });

  test('logout ends the session', async () => {
    const { cookie } = await signupOrg();
    const res = await call('POST', '/auth/logout', { cookie });
    expect(res.status).toBe(200);
    expect(res.rawCookie).toContain('Max-Age=0');
    expect((await refresh(cookie)).status).toBe(401);
  });

  test('the email verification link works once', async () => {
    const { email, token } = await signupOrg();
    const link = tokenFromLastEmail(email);
    expect((await call('POST', '/auth/verify-email', { body: { token: link } })).status).toBe(200);
    expect((await call<Me>('GET', '/me', { token })).data.user.emailVerifiedAt).not.toBeNull();
    expect((await call('POST', '/auth/verify-email', { body: { token: link } })).status).toBe(400);
  });

  test('password reset by email: one use, new password works, every session is signed out', async () => {
    const { email, cookie } = await signupOrg();
    expect((await call('POST', '/auth/forgot-password', { body: { email: uniqueEmail('nobody') } })).status).toBe(200);
    expect((await call('POST', '/auth/forgot-password', { body: { email } })).status).toBe(200);

    const resetToken = tokenFromLastEmail(email);
    const body = { token: resetToken, password: 'a brand new password' };
    expect((await call('POST', '/auth/reset-password', { body })).status).toBe(200);
    expect((await call('POST', '/auth/reset-password', { body })).status).toBe(400);

    expect((await login(email)).status).toBe(401);
    expect((await login(email, 'a brand new password')).status).toBe(200);
    expect((await refresh(cookie)).status).toBe(401);
  });

  test('changing the password voids old access tokens and other sessions', async () => {
    const { email, token: firstToken } = await signupOrg();
    const otherDevice = await login(email);

    const changed = await call<Session>('POST', '/me/password', {
      token: firstToken,
      body: { currentPassword: PASSWORD, newPassword: 'another good password' },
    });
    expect(changed.status).toBe(200);
    expect((await call('GET', '/me', { token: firstToken })).status).toBe(401);
    expect((await refresh(otherDevice.refreshCookie ?? '')).status).toBe(401);
    expect((await call('GET', '/me', { token: changed.data.accessToken })).status).toBe(200);

    const wrong = await call('POST', '/me/password', {
      token: changed.data.accessToken,
      body: { currentPassword: 'wrong password', newPassword: 'yet another password' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.error?.details).toEqual({ fields: [{ path: 'currentPassword', message: 'Incorrect password' }] });
  });
});
