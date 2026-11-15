import { describe, expect, test } from 'bun:test';
import { decodeOrgLogo, MAX_ORG_LOGO_BYTES } from '../src/lib/org_logo';

const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8CGSAAAAAASUVORK5CYII=', 'base64');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('decodeOrgLogo', () => {
  test('accepts a structurally valid tiny PNG with matching content type', () => {
    const decoded = decodeOrgLogo({ contentType: 'image/png', data: VALID_PNG.toString('base64') });
    expect(decoded.equals(VALID_PNG)).toBe(true);
  });

  test('rejects signature-only fakes, mismatched types and oversized data', () => {
    expect(() => decodeOrgLogo({ contentType: 'image/png', data: PNG_SIGNATURE.toString('base64') })).toThrow();
    expect(() => decodeOrgLogo({ contentType: 'image/jpeg', data: VALID_PNG.toString('base64') })).toThrow();
    expect(MAX_ORG_LOGO_BYTES).toBe(64 * 1024);
    expect(() => decodeOrgLogo({ contentType: 'image/png', data: Buffer.alloc(MAX_ORG_LOGO_BYTES + 1, 1).toString('base64') })).toThrow();
  });
});
