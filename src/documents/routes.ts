import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  can,
  documentCreateSchema,
  documentRequestSchema,
  documentReviewSchema,
  documentTargetSchema,
  type DocumentItem,
  type DocumentList,
} from '@shop/shared';
import type { AppEnv, AuthEnv, CustomerAppEnv } from '../lib/hono';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../lib/errors';
import { parseId } from '../lib/ids';
import { authenticate } from '../middleware/authenticate';
import { rateLimit } from '../middleware/rate_limit';
import { env } from '../config/env';
import { withTransaction } from '../db/transaction';
import { acrossTenants } from '../db/tenant_guard';
import { Document, DocumentRequest, DocumentQuota } from '../models/document';
import {
  actorId,
  documentContext,
  guarantorCategory,
  mayReadIdentity,
  mayReview,
  type Principal,
  type DocumentContext,
  type DocumentRecord,
} from './access';
import { documentAudit } from './audit';
import { documentStorageReady, getDocumentStorage } from './storage';

let activeUploads = 0;
const uploadCapacity = async (_c: Context, next: () => Promise<void>) => {
  if (activeUploads >= 2)
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'Uploads are busy. Please try again shortly.');
  activeUploads++;
  try {
    await next();
  } finally {
    activeUploads--;
  }
};
const uploadLimit = rateLimit({ windowMs: 60_000, max: 60, enabled: env.NODE_ENV !== 'test' });
const input = <T>(schema: z.ZodType<T>, value: unknown) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError('Check the document details.');
  return parsed.data;
};
async function readJson(c: Context) {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError('Send valid document details.');
  }
}
const privateSelect = '+sourceKey +storedKey +previewKey +sourceHash +storedHash +previewHash';
const same = (a: unknown, b: unknown) => String(a) === String(b);
const filename = (type: string) => (type === 'application/pdf' ? 'document.pdf' : 'document.jpg');
type Doc = DocumentRecord;
type DocumentEnv = AppEnv & { Variables: { documentPrincipal: Principal } };
function mayView(
  p: Principal,
  d: { category: string; processing: string; uploadedBy: string; actorId: Types.ObjectId },
) {
  if (d.processing !== 'ready') return false;
  // Categories are user input: a mislabeled CNIC must not grant staff or another customer access.
  return p.kind === 'customer'
    ? d.uploadedBy === 'customer' && same(d.actorId, actorId(p)) && !guarantorCategory(d.category)
    : mayReadIdentity(p);
}
function mayDelete(
  p: Principal,
  d: { actorId: Types.ObjectId; review: string; processing: string; legalHold: boolean },
) {
  return (
    !d.legalHold &&
    d.processing !== 'deleted' &&
    ((p.kind === 'staff' && can(p.auth.role, 'documents.delete')) ||
      (same(actorId(p), d.actorId) && d.review === 'pending'))
  );
}
function serialize(p: Principal, doc: Doc, ctx?: DocumentContext): DocumentItem {
  return {
    _id: String(doc._id),
    ...(doc.replacesId ? { replacesId: String(doc.replacesId) } : {}),
    ...(doc.requestId ? { requestId: String(doc.requestId) } : {}),
    category: doc.category,
    ...(p.kind === 'staff' && doc.guarantorId ? { guarantorId: doc.guarantorId } : {}),
    subject: doc.guarantorId
      ? p.kind === 'staff'
        ? (ctx?.guarantors.find((person) => person.id === doc.guarantorId)?.fullName ?? 'Guarantor record')
        : 'Guarantor document'
      : 'Customer / contract',
    processing: doc.processing,
    review: doc.review,
    feedback: doc.feedback,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    uploadedBy: doc.uploadedBy,
    version: doc.version,
    bytes: doc.bytes ?? undefined,
    contentType: doc.contentType ?? undefined,
    legalHold: doc.legalHold,
    canHold: p.kind === 'staff' && p.auth.role === 'owner',
    canView: mayView(p, doc),
    canDelete: mayDelete(p, doc),
    canReview: mayReview(p) && doc.processing === 'ready' && doc.review === 'pending',
  };
}
async function load(p: Principal, id: string) {
  const filter = { _id: parseId(id, 'Document'), ...(p.kind === 'staff' ? { orgId: p.auth.orgId } : {}) };
  const query = Document.findOne(filter).select(privateSelect);
  const doc = await (p.kind === 'customer' ? acrossTenants(query) : query);
  if (!doc || doc.processing === 'deleted') throw new NotFoundError('Document');
  const context = await documentContext(
    p,
    doc.contractId ? { contractId: String(doc.contractId) } : { customerId: String(doc.customerId) },
  );
  if (
    !same(context.orgId, doc.orgId) ||
    !same(context.customerId, doc.customerId) ||
    (p.kind === 'customer' && (doc.uploadedBy !== 'customer' || !same(doc.actorId, actorId(p))))
  )
    throw new NotFoundError('Document');
  return { doc, context };
}

export function documentRoutes() {
  return new Hono<DocumentEnv>()
    .use('*', async (c, next) => {
      c.header('Cache-Control', 'private, no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      await next();
    })
    .get('/', async (c) => {
      const p = c.var.documentPrincipal;
      const target = input(documentTargetSchema, c.req.query());
      const cursor = c.req.query('cursor');
      const ctx = await documentContext(p, target, {
        cursor: cursor ? parseId(cursor, 'Document') : undefined,
      });
      const docs = ctx.records ?? [];
      const requests = ctx.requests ?? [];
      const items = docs.slice(0, 20).map((doc) => serialize(p, doc, ctx));
      const data: DocumentList = {
        items,
        nextCursor: docs.length > 20 ? items.at(-1)!._id : null,
        requests: requests.map((r) => ({
          _id: String(r._id),
          category: r.category,
          subject: r.guarantorId ? 'Guarantor document' : 'Customer / contract',
          message: r.message,
        })),
        subjects:
          p.kind === 'staff'
            ? ctx.guarantors.filter((g) => g.id).map((g) => ({ id: g.id!, label: g.fullName }))
            : [],
        policy: ctx.policy,
        available: documentStorageReady(),
        canUpload:
          ctx.policy.enabled &&
          documentStorageReady() &&
          (p.kind === 'staff' ? can(p.auth.role, 'documents.write') : ctx.policy.customerUploads),
        canReview: mayReview(p),
      };
      return c.json({ data });
    })
    .post('/requests', uploadLimit, async (c) => {
      const p = c.var.documentPrincipal;
      if (p.kind !== 'staff' || !can(p.auth.role, 'documents.write')) throw new ForbiddenError();
      const body = input(documentRequestSchema, await readJson(c));
      const ctx = await documentContext(p, body);
      if (!ctx.policy.enabled || !ctx.policy.customerUploads || !documentStorageReady())
        throw new ConflictError('Customer document uploads are not enabled.');
      if (guarantorCategory(body.category) && !ctx.guarantors.some((g) => g.id === body.guarantorId))
        throw new ValidationError('Choose an existing guarantor.');
      const request = await withTransaction(async () => {
        const created = await DocumentRequest.create({
          ...body,
          orgId: ctx.orgId,
          branchId: ctx.branchId,
          customerId: ctx.customerId,
          createdBy: p.auth._id,
        });
        await documentAudit(p, ctx, created._id, 'document.requested');
        return created;
      });
      return c.json(
        {
          data: {
            _id: String(request._id),
            category: request.category,
            subject: request.guarantorId ? 'Guarantor document' : 'Customer / contract',
            message: request.message,
          },
        },
        201,
      );
    })
    .post('/', uploadLimit, async (c) => {
      const p = c.var.documentPrincipal;
      const body = input(documentCreateSchema, await readJson(c));
      if (p.kind === 'customer' && !body.contractId)
        throw new ValidationError('Choose your plan and retailer.');
      const ctx = await documentContext(p, body);
      if (
        !ctx.policy.enabled ||
        !documentStorageReady() ||
        (p.kind === 'customer' && !ctx.policy.customerUploads)
      )
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'Document uploads are not available.');
      if (p.kind === 'staff' && !can(p.auth.role, 'documents.write')) throw new ForbiddenError();
      let guarantorId = body.guarantorId;
      if (body.requestId) {
        const request = await DocumentRequest.findOne({
          _id: body.requestId,
          orgId: ctx.orgId,
          contractId: ctx.contractId,
          customerId: ctx.customerId,
          closedAt: null,
        }).lean();
        if (!request || request.category !== body.category) throw new NotFoundError('Document request');
        guarantorId = request.guarantorId ?? undefined;
      }
      if (guarantorCategory(body.category)) {
        if (
          !ctx.contractId ||
          !ctx.guarantors.some((g) => g.id === guarantorId) ||
          (p.kind === 'customer' && !body.requestId)
        )
          throw new ValidationError('A specific guarantor document request is required.');
      } else if (guarantorId) throw new ValidationError('This category is not a guarantor document.');
      if (!ctx.contractId && !body.category.startsWith('customer_cnic'))
        throw new ValidationError('Attach this document to a contract.');
      if (body.replacesId) {
        const { doc } = await load(p, body.replacesId);
        if (
          !same(doc.customerId, ctx.customerId) ||
          !same(doc.contractId, ctx.contractId) ||
          doc.category !== body.category ||
          doc.guarantorId !== (guarantorId ?? null) ||
          doc.legalHold ||
          doc.review === 'superseded'
        )
          throw new ConflictError('Choose a replacement for the same document and person.');
      }
      const doc = await withTransaction(async () => {
        const existing = await Document.findOne({
          orgId: ctx.orgId,
          actorId: actorId(p),
          idempotencyKey: body.idempotencyKey,
        });
        if (existing) {
          if (
            !same(existing.customerId, ctx.customerId) ||
            !same(existing.contractId, ctx.contractId) ||
            existing.category !== body.category ||
            existing.guarantorId !== (guarantorId ?? null) ||
            !same(existing.requestId, body.requestId ?? null) ||
            !same(existing.replacesId, body.replacesId ?? null) ||
            existing.processing === 'deleted'
          )
            throw new ConflictError('This upload key was used for another document.');
          return existing;
        }
        try {
          await DocumentQuota.findOneAndUpdate(
            {
              _id: `${ctx.orgId}:daily:${actorId(p)}:${new Date().toISOString().slice(0, 10)}`,
              orgId: ctx.orgId,
              count: { $lt: 100 },
            },
            { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 2 * 86_400_000) } },
            { upsert: true },
          );
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 11000)
            throw new AppError(
              'RATE_LIMITED',
              429,
              'Your daily upload limit has been reached. Please try again tomorrow.',
            );
          throw error;
        }
        {
          try {
            await DocumentQuota.findOneAndUpdate(
              {
                _id: `${ctx.orgId}:${ctx.contractId ?? ctx.customerId}`,
                orgId: ctx.orgId,
                count: { $lt: ctx.policy.maxFiles + (body.replacesId ? 1 : 0) },
              },
              { $inc: { count: 1 } },
              { upsert: true },
            );
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 11000)
              throw new ConflictError(
                'The document limit has been reached. Replace an existing document or contact the shop.',
              );
            throw error;
          }
        }
        const created = await Document.create({
          orgId: ctx.orgId,
          branchId: ctx.branchId,
          customerId: ctx.customerId,
          contractId: ctx.contractId,
          category: body.category,
          guarantorId,
          requestId: body.requestId,
          actorId: actorId(p),
          uploadedBy: p.kind,
          sessionId: p.kind === 'customer' ? p.claims.sid : null,
          accountVersion: p.kind === 'customer' ? p.claims.ver : null,
          idempotencyKey: body.idempotencyKey,
          replacesId: body.replacesId,
          replacementOpen: Boolean(body.replacesId),
          consentAt: new Date(),
          policySnapshot: ctx.policy,
          ...(!ctx.contractId
            ? {
                retentionStartsAt: new Date(),
                expiresAt: new Date(Date.now() + ctx.policy.retentionDays * 86_400_000),
              }
            : {}),
        });
        await documentAudit(p, ctx, created._id, 'document.created');
        return created;
      });
      return c.json({ data: serialize(p, doc, ctx) }, 201);
    })
    .put('/:id/content', uploadLimit, uploadCapacity, async (c) => {
      const p = c.var.documentPrincipal;
      const { doc, context: ctx } = await load(p, c.req.param('id'));
      if (
        !same(doc.actorId, actorId(p)) ||
        !ctx.policy.enabled ||
        (p.kind === 'customer' &&
          (!ctx.policy.customerUploads ||
            doc.sessionId !== p.claims.sid ||
            doc.accountVersion !== p.claims.ver))
      )
        throw new ForbiddenError();
      if (doc.processing === 'processing' || doc.processing === 'ready')
        return c.json({ data: serialize(p, doc, ctx) });
      if (doc.processing !== 'uploading' || Date.now() - doc.createdAt.getTime() > 86_400_000)
        throw new ConflictError('Create a new upload.');
      const lease = crypto.randomUUID();
      const key = `${ctx.orgId}/${doc._id}/source-${crypto.randomUUID()}`;
      const claimed = await Document.updateOne(
        {
          _id: doc._id,
          orgId: ctx.orgId,
          processing: 'uploading',
          $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }],
        },
        {
          $set: { uploadLease: lease, leaseUntil: new Date(Date.now() + 15 * 60_000) },
          $addToSet: { garbageKeys: key },
        },
      );
      if (!claimed.modifiedCount) throw new ConflictError('This file is already uploading.');
      let dir: string | undefined;
      try {
        dir = await mkdtemp(join(tmpdir(), 'qist-document-'));
        const path = join(dir, 'source');
        const file = await open(path, 'wx', 0o600);
        let bytes = 0;
        const hash = createHash('sha256');
        try {
          if (!c.req.raw.body) throw new ValidationError('Choose a file.');
          const reader = c.req.raw.body.getReader();
          let timedOut = false;
          const timeout = setTimeout(() => {
            timedOut = true;
            void reader.cancel().catch(() => {});
          }, 120_000);
          try {
            while (true) {
              const { value: chunk, done } = await reader.read();
              if (timedOut)
                throw new ValidationError('The upload timed out. Try again with a working connection.');
              if (done) break;
              bytes += chunk.byteLength;
              if (
                bytes >
                Math.min(
                  ctx.policy.maxFileBytes,
                  (doc.policySnapshot as { maxFileBytes: number }).maxFileBytes,
                )
              )
                throw new PayloadTooLargeError();
              hash.update(chunk);
              let offset = 0;
              while (offset < chunk.length) {
                const result = await file.write(chunk, offset, chunk.length - offset);
                if (!result.bytesWritten)
                  throw new AppError('SERVICE_UNAVAILABLE', 503, 'The upload could not be saved.');
                offset += result.bytesWritten;
              }
            }
          } finally {
            clearTimeout(timeout);
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        } finally {
          await file.close();
        }
        if (!bytes) throw new ValidationError('Choose a non-empty file.');
        await getDocumentStorage().write(key, Bun.file(path), 'application/octet-stream');
        // Re-check revocation/ownership after receiving bytes; the client cannot publish directly.
        const latest = await documentContext(
          p,
          doc.contractId ? { contractId: String(doc.contractId) } : { customerId: String(doc.customerId) },
        );
        if (!latest.policy.enabled || (p.kind === 'customer' && !latest.policy.customerUploads))
          throw new ForbiddenError();
        const updated = await Document.findOneAndUpdate(
          { _id: doc._id, orgId: ctx.orgId, processing: 'uploading', uploadLease: lease },
          {
            $set: {
              processing: 'processing',
              sourceKey: key,
              sourceHash: hash.digest('hex'),
              bytes,
              leaseUntil: null,
              uploadLease: null,
            },
            $pull: { garbageKeys: key },
            $inc: { version: 1 },
          },
          { returnDocument: 'after' },
        );
        if (!updated) throw new ConflictError('This upload was cancelled.');
        return c.json({ data: serialize(p, updated, ctx) });
      } catch (error) {
        // The key stays in the durable cleanup list until deletion succeeds, including uncertain R2 writes.
        await getDocumentStorage()
          .remove(key)
          .then(() => Document.updateOne({ _id: doc._id, orgId: ctx.orgId }, { $pull: { garbageKeys: key } }))
          .catch(() => {});
        await Document.updateOne(
          { _id: doc._id, orgId: ctx.orgId, uploadLease: lease },
          { $set: { leaseUntil: null, uploadLease: null } },
        );
        throw error;
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    })
    .get('/:id/content', async (c) => {
      const p = c.var.documentPrincipal;
      const { doc, context: ctx } = await load(p, c.req.param('id'));
      if (!mayView(p, doc) || !doc.storedKey)
        throw new ForbiddenError('This document is not available for viewing.');
      const preview = c.req.query('preview') === '1';
      if (preview && !doc.previewKey) throw new NotFoundError('Preview');
      const bytes = await getDocumentStorage().read(preview ? doc.previewKey! : doc.storedKey);
      const expectedHash = preview ? doc.previewHash : doc.storedHash;
      if (!expectedHash || createHash('sha256').update(bytes).digest('hex') !== expectedHash)
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'This document is temporarily unavailable.');
      const current = await load(p, c.req.param('id'));
      if (!mayView(p, current.doc) || current.doc.version !== doc.version)
        throw new ConflictError('The document has changed.');
      await documentAudit(p, ctx, doc._id, preview ? 'document.previewed' : 'document.downloaded');
      c.header('Content-Type', preview ? 'image/jpeg' : (doc.contentType ?? 'application/octet-stream'));
      c.header(
        'Content-Disposition',
        `${preview ? 'inline' : 'attachment'}; filename="${filename(preview ? 'image/jpeg' : (doc.contentType ?? ''))}"`,
      );
      return c.body(Buffer.from(bytes));
    })
    .post('/:id/review', async (c) => {
      const p = c.var.documentPrincipal;
      if (!mayReview(p) || p.kind !== 'staff') throw new ForbiddenError();
      const body = input(documentReviewSchema, await readJson(c));
      if (body.decision === 'rejected' && body.feedback.length < 3)
        throw new ValidationError('Explain what needs to be replaced.');
      const { doc, context: ctx } = await load(p, c.req.param('id'));
      const updated = await withTransaction(async () => {
        const next = await Document.findOneAndUpdate(
          { _id: doc._id, orgId: ctx.orgId, processing: 'ready', review: 'pending', version: body.version },
          {
            $set: {
              review: body.decision,
              feedback: body.feedback,
              reviewedAt: new Date(),
              reviewedBy: p.auth._id,
              replacementOpen: false,
              ...(body.decision === 'rejected' ? { quotaCounted: false } : {}),
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after' },
        );
        if (!next) throw new ConflictError('This document has changed. Refresh before reviewing it.');
        if (body.decision === 'rejected' && doc.quotaCounted)
          await DocumentQuota.updateOne(
            { _id: `${ctx.orgId}:${ctx.contractId ?? ctx.customerId}`, orgId: ctx.orgId, count: { $gt: 0 } },
            { $inc: { count: -1 } },
          );
        if (doc.replacesId && body.decision === 'accepted') {
          const previous = await Document.findOneAndUpdate(
            {
              _id: doc.replacesId,
              orgId: ctx.orgId,
              processing: { $ne: 'deleted' },
              review: { $ne: 'superseded' },
            },
            { $set: { review: 'superseded', quotaCounted: false }, $inc: { version: 1 } },
          );
          if (!previous) throw new ConflictError('The original document changed.');
          if (previous.quotaCounted)
            await DocumentQuota.updateOne(
              {
                _id: `${ctx.orgId}:${ctx.contractId ?? ctx.customerId}`,
                orgId: ctx.orgId,
                count: { $gt: 0 },
              },
              { $inc: { count: -1 } },
            );
        }
        if (doc.requestId && body.decision === 'accepted')
          await DocumentRequest.updateOne(
            { _id: doc.requestId, orgId: ctx.orgId },
            { $set: { closedAt: new Date() } },
          );
        await documentAudit(p, ctx, doc._id, `document.${body.decision}`);
        return next;
      });
      return c.json({ data: serialize(p, updated, ctx) });
    })
    .post('/:id/hold', async (c) => {
      const p = c.var.documentPrincipal;
      if (p.kind !== 'staff' || p.auth.role !== 'owner') throw new ForbiddenError();
      const body = input(
        z.object({ version: z.number().int().nonnegative(), hold: z.boolean() }),
        await readJson(c),
      );
      const { doc, context: ctx } = await load(p, c.req.param('id'));
      const updated = await withTransaction(async () => {
        const next = await Document.findOneAndUpdate(
          { _id: doc._id, orgId: ctx.orgId, version: body.version, processing: { $ne: 'deleted' } },
          { $set: { legalHold: body.hold }, $inc: { version: 1 } },
          { returnDocument: 'after' },
        );
        if (!next) throw new ConflictError('This document has changed. Refresh before changing its hold.');
        await documentAudit(p, ctx, doc._id, body.hold ? 'document.hold_placed' : 'document.hold_removed');
        return next;
      });
      return c.json({ data: serialize(p, updated, ctx) });
    })
    .delete('/:id', async (c) => {
      const p = c.var.documentPrincipal;
      const { doc, context: ctx } = await load(p, c.req.param('id'));
      if (c.req.query('version') !== String(doc.version))
        throw new ConflictError('The document has changed. Refresh before deleting it.');
      if (!mayDelete(p, doc)) throw new ForbiddenError();
      const updated = await withTransaction(async () => {
        const next = await Document.findOneAndUpdate(
          {
            _id: doc._id,
            orgId: ctx.orgId,
            processing: { $ne: 'deleted' },
            version: doc.version,
            legalHold: false,
          },
          {
            $set: {
              processing: 'deleted',
              deletedAt: new Date(),
              replacementOpen: false,
              quotaCounted: false,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after' },
        );
        if (!next) throw new ConflictError('The document has changed.');
        if (doc.quotaCounted)
          await DocumentQuota.updateOne(
            { _id: `${ctx.orgId}:${ctx.contractId ?? ctx.customerId}`, orgId: ctx.orgId, count: { $gt: 0 } },
            { $inc: { count: -1 } },
          );
        await documentAudit(p, ctx, doc._id, 'document.deleted');
        return next;
      });
      return c.json({ data: serialize(p, updated, ctx) });
    });
}
export const staffDocumentRoutes = new Hono<AuthEnv & DocumentEnv>()
  .use(authenticate)
  .use(async (c, next) => {
    c.set('documentPrincipal', { kind: 'staff', auth: c.var.auth });
    await next();
  })
  .route('/', documentRoutes());
export const customerDocumentRoutes = new Hono<CustomerAppEnv & DocumentEnv>()
  .use(async (c, next) => {
    c.set('documentPrincipal', { kind: 'customer', claims: c.var.customer });
    await next();
  })
  .route('/', documentRoutes());
