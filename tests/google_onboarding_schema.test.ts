import { describe, expect, test } from 'bun:test';
import { googleLinkSchema, googleAuthSchema, googleOnboardingSchema, loginSchema, orgLogoUpdateSchema } from '@shop/shared';
import { User } from '../src/models/user';

describe('Google sign-in and retailer onboarding contracts', () => {
  test('requires a real-length Google credential and never accepts a blank link request', () => {
    expect(googleLinkSchema.safeParse({ credential: '' }).success).toBe(false);
    expect(googleLinkSchema.safeParse({ credential: 'a'.repeat(24) }).success).toBe(true);
    expect(googleAuthSchema.safeParse({ credential: 'a'.repeat(24) }).success).toBe(true);
  });

  test('requires owner name, shop details and a matching password while keeping the logo optional', () => {
    const valid = {
      fullName: 'Ayesha Khan',
      shopName: 'Al-Madina Mobiles',
      phone: '03001234567',
      address: 'Shop 12, Faisalabad',
      password: 'correct horse battery',
      confirmPassword: 'correct horse battery',
    };
    expect(googleOnboardingSchema.safeParse(valid).success).toBe(true);
    expect(googleOnboardingSchema.safeParse({ ...valid, phone: '' }).success).toBe(false);
    expect(googleOnboardingSchema.safeParse({ ...valid, fullName: '' }).success).toBe(false);
    expect(googleOnboardingSchema.safeParse({ ...valid, confirmPassword: 'different password' }).success).toBe(false);
    expect(googleOnboardingSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  test('staff sign-in accepts email and password, never a branch phone number', () => {
    expect(loginSchema.safeParse({ email: 'owner@example.com', password: 'correct horse battery' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: '03001234567', password: 'correct horse battery' }).success).toBe(false);
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
