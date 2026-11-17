import { model, Schema } from 'mongoose';
import { DOCUMENT_CATEGORIES } from '@shop/shared';
import { tenantGuard } from '../db/tenant_guard';

const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    branchId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, required: true },
    contractId: { type: Schema.Types.ObjectId, default: null },
    guarantorId: { type: String, default: null },
    category: { type: String, enum: DOCUMENT_CATEGORIES, required: true },
    uploadedBy: { type: String, enum: ['staff', 'customer'], required: true },
    actorId: { type: Schema.Types.ObjectId, required: true },
    sessionId: { type: String, default: null },
    accountVersion: { type: Number, default: null },
    idempotencyKey: { type: String, required: true },
    requestId: { type: Schema.Types.ObjectId, default: null },
    replacesId: { type: Schema.Types.ObjectId, default: null },
    replacementOpen: { type: Boolean, default: false },
    processing: {
      type: String,
      enum: ['uploading', 'processing', 'ready', 'failed', 'rejected', 'deleted'],
      default: 'uploading',
    },
    review: { type: String, enum: ['pending', 'accepted', 'rejected', 'superseded'], default: 'pending' },
    quotaCounted: { type: Boolean, default: true },
    version: { type: Number, default: 0 },
    feedback: { type: String, default: '' },
    reviewedBy: { type: Schema.Types.ObjectId, default: null },
    reviewedAt: { type: Date, default: null },
    consentAt: { type: Date, required: true },
    policySnapshot: { type: Schema.Types.Mixed, required: true },
    bytes: { type: Number },
    contentType: { type: String },
    sourceHash: { type: String, select: false },
    storedHash: { type: String, select: false },
    previewHash: { type: String, select: false },
    sourceKey: { type: String, select: false },
    storedKey: { type: String, select: false },
    previewKey: { type: String, select: false },
    leaseUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    uploadLease: { type: String, default: null },
    garbageKeys: { type: [String], default: [], select: false },
    retentionStartsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    legalHold: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    purgedAt: { type: Date, default: null },
  },
  { collection: 'documents', timestamps: true, versionKey: false },
);
schema.index({ orgId: 1, actorId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ orgId: 1, contractId: 1, _id: -1 });
schema.index({ orgId: 1, customerId: 1, _id: -1 });
schema.index(
  { orgId: 1, replacesId: 1 },
  { unique: true, partialFilterExpression: { replacementOpen: true } },
);
schema.index({ expiresAt: 1, legalHold: 1 });
schema.index({ processing: 1, leaseUntil: 1, updatedAt: 1 });
schema.plugin(tenantGuard);
export const Document = model('Document', schema);

const request = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    branchId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, required: true },
    contractId: { type: Schema.Types.ObjectId, required: true },
    guarantorId: { type: String, default: null },
    category: { type: String, enum: DOCUMENT_CATEGORIES, required: true },
    message: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    closedAt: { type: Date, default: null },
  },
  { collection: 'document_requests', timestamps: true, versionKey: false },
);
request.index({ orgId: 1, contractId: 1, closedAt: 1 });
request.plugin(tenantGuard);
export const DocumentRequest = model('DocumentRequest', request);

const quota = new Schema(
  {
    _id: String,
    orgId: { type: Schema.Types.ObjectId, required: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date },
  },
  { collection: 'document_quotas', versionKey: false },
);
quota.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
quota.plugin(tenantGuard);
export const DocumentQuota = model('DocumentQuota', quota);
