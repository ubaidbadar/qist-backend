import { describe, expect, test } from 'bun:test';
import { parseEnv } from '../src/config/env';
import { VALID_RELEASE } from './customer_install_fixture';

const VALID = {
  MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net',
  MONGODB_DB: 'shop',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  INTERNAL_JOB_SECRET: 'c'.repeat(32),
  APP_ORIGIN: 'http://localhost:3000',
};

describe('parseEnv', () => {
  test('Google web client ID is optional and empty means disabled', () => {
    expect(parseEnv({ ...VALID, GOOGLE_CLIENT_ID: '' }).GOOGLE_CLIENT_ID).toBeUndefined();
    expect(parseEnv({ ...VALID, GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com' }).GOOGLE_CLIENT_ID).toBe('123.apps.googleusercontent.com');
  });

  test('customer APK configuration is optional, validated and independent of enrollment', () => {
    expect(parseEnv({ ...VALID, CUSTOMER_APP_RELEASE_JSON: '' }).CUSTOMER_APP_RELEASE_JSON).toBeUndefined();
    expect(parseEnv({ ...VALID, CUSTOMER_APP_RELEASE_JSON: JSON.stringify(VALID_RELEASE) }).CUSTOMER_APP_RELEASE_JSON?.wifiOnly).toBe(true);
    expect(() => parseEnv({ ...VALID, CUSTOMER_APP_RELEASE_JSON: '{broken' })).toThrow('CUSTOMER_APP_RELEASE_JSON');
    expect(() => parseEnv({ ...VALID, CUSTOMER_APP_RELEASE_JSON: '{}' })).toThrow('CUSTOMER_APP_RELEASE_JSON');
  });
  test('accepts a complete development env and applies defaults', () => {
    const env = parseEnv(VALID);
    expect(env.PORT).toBe(5001);
    expect(env.NODE_ENV).toBe('development');
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.CUSTOMER_APP_MAINTENANCE).toBe(false);
  });

  test('rejects short and identical JWT secrets without printing their values', () => {
    expect(() => parseEnv({ ...VALID, JWT_ACCESS_SECRET: 'short' })).toThrow('JWT_ACCESS_SECRET');
    expect(() => parseEnv({ ...VALID, JWT_REFRESH_SECRET: VALID.JWT_ACCESS_SECRET })).toThrow('must differ');
    expect(() => parseEnv({ ...VALID, JWT_ACCESS_SECRET: 'short' })).not.toThrow('short"');
  });

  test('treats empty optional values as not configured', () => {
    expect(parseEnv({ ...VALID, R2_BUCKET: '', SMTP_HOST: '' }).R2_BUCKET).toBeUndefined();
  });

  test('requires R2 and email credentials in production', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'production' })).toThrow('R2_BUCKET');
  });

  test('requires the device app download over https in production, and a well-formed signature checksum', () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'production' })).toThrow('DEVICE_APP_APK_URL');
    expect(() => parseEnv({ ...VALID, NODE_ENV: 'production', DEVICE_APP_APK_URL: 'http://example.com/app.apk' })).toThrow('must use https');
    expect(() => parseEnv({ ...VALID, DEVICE_APP_SIGNATURE_CHECKSUM: 'abc==' })).toThrow('DEVICE_APP_SIGNATURE_CHECKSUM');
    expect(parseEnv({ ...VALID, DEVICE_APP_SIGNATURE_CHECKSUM: 'A'.repeat(43) }).DEVICE_APP_SIGNATURE_CHECKSUM).toBe('A'.repeat(43));
  });
});
