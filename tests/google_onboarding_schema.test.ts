import { describe, expect, test } from 'bun:test';
import { googleLinkSchema, googleAuthSchema, googleOnboardingSchema, orgLogoUpdateSchema } from '@shop/shared';
import { User } from '../src/models/user';

describe('Google sign-in and retailer onboarding contracts', () => {
  test('requires a real-length Google credential and never accepts a blank link request', () => {
    expect(googleLinkSchema.safeParse({ credential: '' }).success).toBe(false);
    expect(googleLinkSchema.safeParse({ credential: 'a'.repeat(24) }).success).toBe(true);
    expect(googleAuthSchema.safeParse({ credential: 'a'.repeat(24) }).success).toBe(true);
  });

  test('requires shop name, phone and address while keeping the logo optional', () => {
    expect(googleOnboardingSchema.safeParse({
      shopName: 'Al-Madina Mobiles', phone: '03001234567', address: 'Shop 12, Faisalabad',
    }).success).toBe(true);
    expect(googleOnboardingSchema.safeParse({
      shopName: 'Al-Madina Mobiles', phone: '', address: 'Shop 12, Faisalabad',
    }).success).toBe(false);
  });

  test('removing a logo requires explicit null', () => {
    expect(orgLogoUpdateSchema.safeParse({ logo: null }).success).toBe(true);
    expect(orgLogoUpdateSchema.safeParse({}).success).toBe(false);
    expect(orgLogoUpdateSchema.safeParse({ logo: { contentType: 'image/svg+xml', data: 'aaaa' } }).success).toBe(false);
  });

  test('existing email users remain password-enabled by default', () => {
    const user = new User({ email: 'owner@example.com', orgId: '000000000000000000000001',
      passwordHash: 'hashed', fullName: 'Owner', role: 'owner' });
    expect(user.passwordEnabled).toBe(true);
  });
});
