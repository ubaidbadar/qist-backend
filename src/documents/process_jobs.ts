import { createHash } from 'node:crypto';
import { Document, DocumentQuota } from '../models/document';
import { acrossTenants } from '../db/tenant_guard';
import { env } from '../config/env';
import { getDocumentStorage, documentStorageReady } from './storage';
import { withTransaction } from '../db/transaction';
import { cleanDocuments } from './cleanup';
import { UnsafeDocumentError } from './errors';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let processing:
  | ((data: Uint8Array) => Promise<{ bytes: Uint8Array; preview?: Uint8Array; contentType: string }>)
  | undefined;
export function setDocumentProcessorForTests(next?: typeof processing) {
  if (env.NODE_ENV !== 'test') throw new Error('Test only');
  processing = next;
}
async function processBytes(bytes: Uint8Array) {
  if (processing) return processing(bytes);
  if (!env.DOCUMENT_PROCESSOR_URL || !env.DOCUMENT_PROCESSOR_SECRET) throw new Error('Processor unavailable');
  const response = await fetch(new URL('/process', env.DOCUMENT_PROCESSOR_URL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DOCUMENT_PROCESSOR_SECRET}`,
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
    signal: AbortSignal.timeout(70_000),
    redirect: 'error',
  });
  if (response.status === 422)
    throw new UnsafeDocumentError('This file could not pass the safety check. Choose another copy.');
  if (!response.ok || !response.body) throw new Error('Processor unavailable');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 20 * 1024 * 1024) throw new Error('Processor response limit');
    chunks.push(chunk);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (
    !data ||
    typeof data !== 'object' ||
    !('contentType' in data) ||
    !['image/jpeg', 'application/pdf'].includes(String(data.contentType)) ||
    !('data' in data) ||
    typeof data.data !== 'string'
  )
    throw new Error('Invalid processor response');
  const result = Buffer.from(data.data, 'base64');
  if (!result.length || result.length > 10 * 1024 * 1024) throw new Error('Processor response limit');
  const preview =
    'preview' in data && typeof data.preview === 'string' ? Buffer.from(data.preview, 'base64') : undefined;
  if (preview && preview.length > 1024 * 1024) throw new Error('Processor preview limit');
  return { bytes: result, contentType: String(data.contentType), preview };
}
/** Durable DB leases, immutable output keys, no processing on the finance/check-in path. */
export async function runDocumentJobs() {
  if (!documentStorageReady()) return;
  const storage = getDocumentStorage();
  for (let count = 0; count < 3; count++) {
    const now = new Date();
    const doc = await acrossTenants(
      Document.findOneAndUpdate(
        {
          processing: 'processing',
          attempts: { $lt: 5 },
          $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
        },
        { $set: { leaseUntil: new Date(Date.now() + 120_000) }, $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      ).select('+sourceKey +sourceHash'),
    );
    if (!doc) break;
    const prefix = `${doc.orgId}/${doc._id}/${crypto.randomUUID()}`;
    const key = `${prefix}/original`;
    const previewKey = `${prefix}/preview`;
    try {
      await Document.updateOne(
        { _id: doc._id, orgId: doc.orgId, leaseUntil: doc.leaseUntil },
        { $addToSet: { garbageKeys: { $each: [key, previewKey] } } },
      );
      if (!doc.sourceKey || !doc.sourceHash) throw new Error('Missing upload');
      const bytes = await storage.read(doc.sourceKey);
      if (bytes.length !== doc.bytes || digest(bytes) !== doc.sourceHash)
        throw new UnsafeDocumentError('The upload changed. Please upload it again.');
      const result = await processBytes(bytes);
      await storage.write(key, new Blob([result.bytes]), result.contentType);
      if (result.preview) await storage.write(previewKey, new Blob([result.preview]), 'image/jpeg');
      const updated = await Document.updateOne(
        { _id: doc._id, orgId: doc.orgId, processing: 'processing', leaseUntil: doc.leaseUntil },
        {
          $set: {
            processing: 'ready',
            storedKey: key,
            previewKey: result.preview ? previewKey : null,
            storedHash: digest(result.bytes),
            previewHash: result.preview ? digest(result.preview) : null,
            contentType: result.contentType,
            feedback: '',
            leaseUntil: null,
          },
          $pull: { garbageKeys: { $in: [key, previewKey] } },
          $inc: { version: 1 },
        },
      );
      if (!updated.modifiedCount) {
        await storage.remove(key);
        if (result.preview) await storage.remove(previewKey);
      }
    } catch (error) {
      await Promise.allSettled([storage.remove(key), storage.remove(previewKey)]);
      const rejected = error instanceof UnsafeDocumentError;
      const terminal = rejected || doc.attempts >= 5;
      await withTransaction(async () => {
        const updated = await Document.updateOne(
          { _id: doc._id, orgId: doc.orgId, processing: 'processing', leaseUntil: doc.leaseUntil },
          {
            $set: {
              processing: rejected ? 'rejected' : terminal ? 'failed' : 'processing',
              replacementOpen: terminal ? false : doc.replacementOpen,
              ...(terminal ? { quotaCounted: false } : {}),
              feedback: rejected
                ? 'This file could not pass the safety check. Upload a readable copy.'
                : 'File checks are delayed. Please try again later.',
              leaseUntil: new Date(Date.now() + 60_000),
            },
            $inc: { version: 1 },
          },
        );
        if (updated.modifiedCount && terminal && doc.quotaCounted)
          await DocumentQuota.updateOne(
            { _id: `${doc.orgId}:${doc.contractId ?? doc.customerId}`, orgId: doc.orgId, count: { $gt: 0 } },
            { $inc: { count: -1 } },
          );
      });
    }
  }
  await cleanDocuments(storage);
}
