import { describe, expect, test } from 'bun:test';
import { googleAuthSchema, googleOnboardingSchema } from './auth';

describe('Google onboarding schemas', () => {
  test('accepts the minimum shop details and leaves the logo optional', () => {
    expect(googleOnboardingSchema.safeParse({
      fullName: 'Test Retailer', password: 'test-password-123', confirmPassword: 'test-password-123',
      shopName: 'Al Madina Mobiles',
      phone: '03001234567',
      address: 'Shop 12, Katchery Bazaar, Faisalabad',
    }).success).toBe(true);
  });

  test('requires shop name, a valid phone number and a shop address', () => {
    expect(googleOnboardingSchema.safeParse({ shopName: '', phone: '', address: '' }).success).toBe(false);
    expect(googleOnboardingSchema.safeParse({
      shopName: 'A good shop',
      phone: 'not a phone',
      address: 'Shop address',
    }).success).toBe(false);
  });

  test('accepts a bounded, base64-encoded optional logo', () => {
    const result = googleAuthSchema.safeParse({
      credential: 'a'.repeat(32),
      onboarding: {
        fullName: 'Test Retailer', password: 'test-password-123', confirmPassword: 'test-password-123',
      shopName: 'Al Madina Mobiles',
        phone: '03001234567',
        address: 'Shop 12, Katchery Bazaar, Faisalabad',
        logo: { contentType: 'image/webp', data: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==' },
      },
    });
    expect(result.success).toBe(true);
  });

  test('rejects SVG and oversized logo payloads', () => {
    const base = { fullName: 'Test Retailer', password: 'test-password-123', confirmPassword: 'test-password-123',
      shopName: 'Al Madina Mobiles', phone: '03001234567', address: 'Shop 12, Katchery Bazaar' };
    expect(googleOnboardingSchema.safeParse({ ...base, logo: { contentType: 'image/svg+xml', data: 'a'.repeat(32) } }).success).toBe(false);
    expect(googleOnboardingSchema.safeParse({ ...base, logo: { contentType: 'image/webp', data: 'a'.repeat(90_001) } }).success).toBe(false);
  });
});
