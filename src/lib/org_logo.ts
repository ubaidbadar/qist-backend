import type { OrgLogoInput } from '@shop/shared';
import { fieldDetails, ValidationError } from './errors';

export const MAX_ORG_LOGO_BYTES = 64 * 1024;

/** Decode and verify the actual image signature; never trust the browser's file type alone. */
export function decodeOrgLogo(logo: OrgLogoInput): Buffer {
  const data = Buffer.from(logo.data, 'base64');
  if (data.length === 0 || data.length > MAX_ORG_LOGO_BYTES) {
    throw new ValidationError('The optimized logo must be 64 KB or smaller', fieldDetails('logo', 'Choose a smaller logo'));
  }

  const isPng = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
  const isWebp = data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  const matchesType =
    (logo.contentType === 'image/png' && isPng) ||
    (logo.contentType === 'image/jpeg' && isJpeg) ||
    (logo.contentType === 'image/webp' && isWebp);

  if (!matchesType) {
    throw new ValidationError('Choose a valid PNG, JPEG or WebP image', fieldDetails('logo', 'The image format could not be verified'));
  }

  return data;
}
