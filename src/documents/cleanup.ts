import { Types } from 'mongoose';
import { Document, DocumentQuota } from '../models/document';
import { acrossTenants } from '../db/tenant_guard';
import { withTransaction } from '../db/transaction';
import { recordSystemAudit } from '../lib/audit';
import { Contract } from '../models/contract';
import type { DocumentStorage } from './storage';

/** All deletion intents persist in Mongo until object deletion succeeds. */
export async function cleanDocuments(storage: DocumentStorage) {
  const now = new Date();
  const closed = await acrossTenants(
    Document.aggregate<{
      _id: Types.ObjectId;
      orgId: Types.ObjectId;
      policySnapshot: { retentionDays: number };
    }>([
      { $match: { contractId: { $ne: null }, retentionStartsAt: null, processing: { $ne: 'deleted' } } },
      {
        $lookup: {
          from: 'contracts',
          let: { id: '$contractId', org: '$orgId' },
          pipeline: [
            {
              $match: {
                status: { $in: ['completed', 'cancelled'] },
                $expr: { $and: [{ $eq: ['$_id', '$$id'] }, { $eq: ['$orgId', '$$org'] }] },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'closed',
        },
      },
      { $match: { 'closed.0': { $exists: true } } },
      { $limit: 30 },
      { $project: { orgId: 1, policySnapshot: 1 } },
    ]),
  );
  for (const doc of closed)
    await Document.updateOne(
      { _id: doc._id, orgId: doc.orgId, retentionStartsAt: null },
      {
        $set: {
          retentionStartsAt: now,
          expiresAt: new Date(now.getTime() + doc.policySnapshot.retentionDays * 86_400_000),
        },
      },
    );

  // Payment voids can reopen an agreement. Restart its post-contract clock on the next completion.
  const reopened = await acrossTenants(
    Document.aggregate<{ _id: Types.ObjectId; orgId: Types.ObjectId }>([
      {
        $match: {
          contractId: { $ne: null },
          retentionStartsAt: { $ne: null },
          processing: { $ne: 'deleted' },
        },
      },
      {
        $lookup: {
          from: 'contracts',
          let: { id: '$contractId', org: '$orgId' },
          pipeline: [
            {
              $match: {
                status: 'active',
                $expr: { $and: [{ $eq: ['$_id', '$$id'] }, { $eq: ['$orgId', '$$org'] }] },
              },
            },
          ],
          as: 'active',
        },
      },
      { $match: { 'active.0': { $exists: true } } },
      { $limit: 30 },
      { $project: { orgId: 1 } },
    ]),
  );
  for (const doc of reopened)
    await Document.updateOne(
      { _id: doc._id, orgId: doc.orgId },
      { $set: { retentionStartsAt: null, expiresAt: null } },
    );

  // Expiry uses the disclosure accepted at upload time, never a silently shortened new policy.
  const expired = await acrossTenants(
    Document.find({
      processing: { $ne: 'deleted' },
      legalHold: false,
      $or: [
        { expiresAt: { $lte: now } },
        { processing: 'uploading', createdAt: { $lt: new Date(now.getTime() - 86_400_000) } },
        {
          processing: { $in: ['failed', 'rejected'] },
          updatedAt: { $lt: new Date(now.getTime() - 30 * 86_400_000) },
        },
      ],
    }).limit(30),
  );
  for (const doc of expired)
    await withTransaction(async () => {
      // Recheck the terminal state inside the deletion transaction, including rows beyond the reset batch.
      if (
        doc.expiresAt &&
        doc.contractId &&
        (await Contract.exists({ _id: doc.contractId, orgId: doc.orgId, status: 'active' }))
      ) {
        await Document.updateOne(
          { _id: doc._id, orgId: doc.orgId, version: doc.version },
          { $set: { retentionStartsAt: null, expiresAt: null } },
        );
        return;
      }
      const result = await Document.updateOne(
        {
          _id: doc._id,
          orgId: doc.orgId,
          legalHold: false,
          processing: doc.processing,
          version: doc.version,
        },
        {
          $set: { processing: 'deleted', deletedAt: now, replacementOpen: false, quotaCounted: false },
          $inc: { version: 1 },
        },
      );
      if (!result.modifiedCount) return;
      if (doc.quotaCounted)
        await DocumentQuota.updateOne(
          { _id: `${doc.orgId}:${doc.contractId ?? doc.customerId}`, orgId: doc.orgId, count: { $gt: 0 } },
          { $inc: { count: -1 } },
        );
      await recordSystemAudit(doc.orgId, {
        action: 'document.expired',
        entity: 'document',
        entityId: doc._id,
        branchId: doc.branchId,
        summary: 'Document access expired',
      });
    });

  const abandoned = await acrossTenants(
    Document.find({
      'garbageKeys.0': { $exists: true },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
    })
      .select('+garbageKeys +sourceKey +storedKey +previewKey')
      .limit(30),
  );
  for (const doc of abandoned)
    for (const key of doc.garbageKeys) {
      if ([doc.sourceKey, doc.storedKey, doc.previewKey].includes(key)) continue;
      try {
        await storage.remove(key);
        await Document.updateOne({ _id: doc._id, orgId: doc.orgId }, { $pull: { garbageKeys: key } });
      } catch {
        /* The persisted key is retried next run. */
      }
    }
  // Normalized images no longer need their original EXIF-bearing quarantine copy.
  const originals = await acrossTenants(
    Document.find({ processing: 'ready', sourceKey: { $exists: true } })
      .select('+sourceKey')
      .limit(30),
  );
  for (const doc of originals)
    if (doc.sourceKey) {
      try {
        await storage.remove(doc.sourceKey);
        await Document.updateOne(
          { _id: doc._id, orgId: doc.orgId, sourceKey: doc.sourceKey, processing: 'ready' },
          { $unset: { sourceKey: 1 } },
        );
      } catch {
        /* Retry without losing the deletion intent. */
      }
    }
  const deleted = await acrossTenants(
    Document.find({
      processing: 'deleted',
      purgedAt: null,
      $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
    })
      .select('+sourceKey +storedKey +previewKey +garbageKeys')
      .limit(30),
  );
  for (const doc of deleted) {
    try {
      for (const key of new Set([doc.sourceKey, doc.storedKey, doc.previewKey, ...doc.garbageKeys]))
        if (key) await storage.remove(key);
      await withTransaction(async () => {
        const result = await Document.updateOne(
          { _id: doc._id, orgId: doc.orgId, processing: 'deleted', purgedAt: null, version: doc.version },
          { $set: { purgedAt: now, garbageKeys: [] }, $unset: { sourceKey: 1, storedKey: 1, previewKey: 1 } },
        );
        if (result.modifiedCount)
          await recordSystemAudit(doc.orgId, {
            action: 'document.purged',
            entity: 'document',
            entityId: doc._id,
            branchId: doc.branchId,
            summary: 'Removed stored document copies',
          });
      });
    } catch {
      /* Keep purgedAt empty so a later job retries. */
    }
  }
}
