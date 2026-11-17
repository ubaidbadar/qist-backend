import { S3Client } from 'bun';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

export interface DocumentStorage {
  write(key: string, file: Blob, contentType: string): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}
let storage: DocumentStorage | undefined;
export function documentStorageReady() {
  return Boolean(
    storage ||
    (env.DOCUMENTS_R2_BUCKET &&
      env.R2_ACCOUNT_ID &&
      env.DOCUMENTS_R2_ACCESS_KEY_ID &&
      env.DOCUMENTS_R2_SECRET_ACCESS_KEY &&
      env.DOCUMENT_PROCESSOR_URL &&
      env.DOCUMENT_PROCESSOR_SECRET),
  );
}
export function getDocumentStorage(): DocumentStorage {
  if (storage) return storage;
  if (!documentStorageReady())
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'Document uploads are not available yet.');
  const client = new S3Client({
    bucket: env.DOCUMENTS_R2_BUCKET,
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: env.DOCUMENTS_R2_ACCESS_KEY_ID,
    secretAccessKey: env.DOCUMENTS_R2_SECRET_ACCESS_KEY,
  });
  storage = {
    async write(key, file, type) {
      await client.file(key).write(file, { type });
    },
    async read(key) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of client.file(key).stream()) {
        length += chunk.byteLength;
        if (length > 10 * 1024 * 1024) throw new Error('Private object exceeds its size limit');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    async remove(key) {
      await client.file(key).delete();
    },
  };
  return storage;
}
/** Dependency injection is test-only; production cannot enable a permissive scanner or in-memory bucket. */
export function setDocumentRuntimeForTests(next?: { storage: DocumentStorage }) {
  if (env.NODE_ENV !== 'test') throw new Error('Test runtime is unavailable');
  storage = next?.storage;
}
