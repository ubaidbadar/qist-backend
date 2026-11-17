import { describe, expect, test } from 'bun:test';
import { signCustomerToken, verifyCustomerToken } from '../src/lib/customer_session';
import { signAccessToken, verifyAccessToken } from '../src/lib/jwt';
import { lockerSigninCode } from '../src/lib/trusted_device_auth';

describe('customer security without database', () => {
  const claims = { sub: '0123456789abcdef01234567', ver: 2, sid: 'a00b4864-7d4d-4d6a-a9ef-10e6b86c12ee' };
  test('customer token round-trip checks its subject, session id and password version', async () => {
    const token = await signCustomerToken(claims, new Date(Date.now() + 60_000));
    expect(await verifyCustomerToken(token)).toEqual(claims);
  });
  test('customer and staff audiences cannot cross', async () => {
    const customer = await signCustomerToken(claims, new Date(Date.now() + 60_000));
    const staff = await signAccessToken({ sub: claims.sub, org: claims.sub, ver: 2 });
    await expect(verifyCustomerToken(staff)).rejects.toThrow('Please sign in again');
    await expect(verifyAccessToken(customer)).rejects.toThrow('Please sign in again');
  });
  test('expiry, modified signatures and malformed claims are rejected', async () => {
    const expired = await signCustomerToken(claims, new Date(0));
    await expect(verifyCustomerToken(expired)).rejects.toThrow('Please sign in again');
    const malformed = await signCustomerToken(
      { ...claims, sid: 'not-a-session-id' },
      new Date(Date.now() + 60_000),
    );
    await expect(verifyCustomerToken(malformed)).rejects.toThrow('Please sign in again');
    await expect(verifyCustomerToken('not.a.signature')).rejects.toThrow('Please sign in again');
  });
  test('Locker codes are stable for a request and bound to its nonce and enrollment key', () => {
    const request = {
      _id: '0123456789abcdef01234567',
      challenge: 'challenge',
      nonceHash: 'nonce',
      keyId: 'key',
    };
    const code = lockerSigninCode(request);
    expect(code).toMatch(/^\d{6}$/);
    expect(lockerSigninCode(request)).toBe(code);
    expect(lockerSigninCode({ ...request, nonceHash: 'different' })).not.toBe(code);
    expect(lockerSigninCode({ ...request, keyId: 'different' })).not.toBe(code);
  });
});
