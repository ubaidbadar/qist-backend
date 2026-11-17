import sharp from 'sharp';
import { UnsafeDocumentError } from './errors';

/** Full image decode, EXIF orientation and metadata removal; PDF bytes remain unchanged. */
export async function validateDocument(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; contentType: string; preview?: Uint8Array }> {
  const bad = () => new UnsafeDocumentError('Choose a readable JPEG, PNG, WebP or unprotected PDF.');
  if (Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: bytes.slice(),
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
      maxImageSize: 25_000_000,
      useWasm: false,
    });
    try {
      const pdf = await task.promise;
      if (
        pdf.numPages < 1 ||
        pdf.numPages > 20 ||
        (await pdf.getJSActions())?.size ||
        (await pdf.getAttachments())?.size
      )
        throw bad();
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        if ((await page.getJSActions())?.size) throw bad();
        const annotations = await page.getAnnotations();
        if (
          annotations.some(
            (a) => a.attachment || a.jsActions || a.action || (a.url && !/^https?:\/\//.test(a.url)),
          )
        )
          throw bad();
        // Parse the entire display list, without executing scripts or fetching remote resources.
        await page.getOperatorList();
        page.cleanup();
      }
      return { bytes, contentType: 'application/pdf' };
    } catch (error) {
      if (error instanceof UnsafeDocumentError) throw error;
      throw bad();
    } finally {
      await task.destroy();
    }
  }
  const header = Buffer.from(bytes.subarray(0, 12));
  if (!(
    (header[0] === 255 && header[1] === 216 && header[2] === 255) ||
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP')
  ))
    throw bad();
  try {
    const input = sharp(bytes, { limitInputPixels: 25_000_000, failOn: 'warning', animated: false });
    const metadata = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw bad();
    const normalized = await input
      .rotate()
      .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    const preview = await sharp(normalized)
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { bytes: normalized, contentType: 'image/jpeg', preview };
  } catch (error) {
    if (error instanceof UnsafeDocumentError) throw error;
    throw bad();
  }
}
