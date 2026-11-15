import { describe, expect, test } from 'bun:test';
import { decodeOrgLogo, MAX_ORG_LOGO_BYTES } from '../src/lib/org_logo';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('decodeOrgLogo', () => {
  test('accepts a PNG with a matching content type', () => {
    const decoded = decodeOrgLogo({ contentType: 'image/png', data: PNG_SIGNATURE.toString('base64') });
    expect(decoded.equals(PNG_SIGNATURE)).toBe(true);
  });

  test('rejects a content-type mismatch and data larger than the limit', () => {
    expect(() => decodeOrgLogo({ contentType: 'image/jpeg', data: PNG_SIGNATURE.toString('base64') })).toThrow();
    expect(MAX_ORG_LOGO_BYTES).toBe(64 * 1024);
    expect(() => decodeOrgLogo({ contentType: 'image/png', data: Buffer.alloc(MAX_ORG_LOGO_BYTES + 1, 1).toString('base64') })).toThrow();
  });
});
