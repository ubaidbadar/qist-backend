import type { OrgLogoInput } from '@shop/shared';
import { fieldDetails, ValidationError } from './errors';

export const MAX_ORG_LOGO_BYTES = 64 * 1024;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WEBP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X']);

function validPng(data: Buffer): boolean {
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 4096) return false;
  // PNG must end with a zero-length IEND chunk and its CRC.
  return data.readUInt32BE(data.length - 12) === 0 && data.toString('ascii', data.length - 8, data.length - 4) === 'IEND';
}

function validJpeg(data: Buffer): boolean {
  return data.length >= 32 && data[0] === 0xff && data[1] === 0xd8 &&
    data[2] === 0xff && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9 &&
    data.includes(Buffer.from([0xff, 0xda]));
}

function validWebp(data: Buffer): boolean {
  return data.length >= 20 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.readUInt32LE(4) === data.length - 8 &&
    data.toString('ascii', 8, 12) === 'WEBP' &&
    WEBP_CHUNKS.has(data.toString('ascii', 12, 16));
}

/**
 * Decode and check structural image markers, not merely the browser's MIME label.
 * This is not a full decoder, but rejects empty/corrupt signatures, oversized files and basic header spoofing.
 */
export function decodeOrgLogo(logo: OrgLogoInput): Buffer {
  const data = Buffer.from(logo.data, 'base64');
  if (data.length === 0 || data.length > MAX_ORG_LOGO_BYTES) {
    throw new ValidationError('The optimized logo must be 64 KB or smaller', fieldDetails('logo', 'Choose a smaller logo'));
  }

  const matchesType =
    (logo.contentType === 'image/png' && validPng(data)) ||
    (logo.contentType === 'image/jpeg' && validJpeg(data)) ||
    (logo.contentType === 'image/webp' && validWebp(data));

  if (!matchesType) {
    throw new ValidationError('Choose a valid PNG, JPEG or WebP image', fieldDetails('logo', 'The image format could not be verified'));
  }

  return data;
}
