import { describe, expect, spyOn, test } from 'bun:test';
import { env } from '../src/config/env';
import { signCustomerToken, verifyCustomerToken } from '../src/lib/customer_session';
import { signAccessToken, verifyAccessToken } from '../src/lib/jwt';
import { requireWhatsApp, sendWhatsAppCode } from '../src/lib/whatsapp';

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
    const malformed = await signCustomerToken({ ...claims, sid: 'not-a-session-id' }, new Date(Date.now() + 60_000));
    await expect(verifyCustomerToken(malformed)).rejects.toThrow('Please sign in again');
    await expect(verifyCustomerToken('not.a.signature')).rejects.toThrow('Please sign in again');
  });
  test('unconfigured WhatsApp has no demo/console success fallback', () => {
    const previous = { NODE_ENV: env.NODE_ENV, WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN };
    env.NODE_ENV = 'development'; env.WHATSAPP_ACCESS_TOKEN = undefined;
    try { expect(requireWhatsApp).toThrow('WhatsApp verification is unavailable'); }
    finally { Object.assign(env, previous); }
  });
  test('Meta failures do not expose provider text or the code', async () => {
    const previous = { NODE_ENV: env.NODE_ENV, WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_AUTH_TEMPLATE: env.WHATSAPP_AUTH_TEMPLATE, WHATSAPP_GRAPH_VERSION: env.WHATSAPP_GRAPH_VERSION };
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private provider response 123456', { status: 500 }));
    Object.assign(env, { NODE_ENV: 'development', WHATSAPP_ACCESS_TOKEN: 'test-only', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_AUTH_TEMPLATE: 'test', WHATSAPP_GRAPH_VERSION: 'v23.0' });
    try {
      await expect(sendWhatsAppCode('03000000000', '123456')).rejects.toThrow('WhatsApp verification is unavailable');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { Object.assign(env, previous); fetch.mockRestore(); }
  });
});
