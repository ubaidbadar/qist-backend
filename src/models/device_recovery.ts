import mongoose, { Schema } from 'mongoose';
import { env } from '../config/env';
import { tenantGuard } from '../db/tenant_guard';

/**
 * A minimal, independent survival record for a provisioned Device Owner.
 *
 * The operator's database-clear script deletes only documents from MONGODB_DB.
 * This separate database preserves the credential verifier and FCM registration
 * so an explicitly approved release can still reach a phone if business data is lost.
 *
 * Never use this store for finance decisions or to revive a deliberately revoked phone.
 * No raw device credentials, customer details, IMEIs or contract details are stored here.
 */
export const recoveryDbName = `${env.MONGODB_DB}_recovery`;
export const recoveryDb = mongoose.connection.useDb(recoveryDbName, { useCache: true });

const schema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    orgId: { type: Schema.Types.ObjectId, required: true },
    branchId: { type: Schema.Types.ObjectId, required: true },
    secretHash: { type: String, required: true, select: false },
    pushToken: { type: String, default: '', select: false },
    status: { type: String, enum: ['active', 'revoked', 'release_requested', 'released'], default: 'active', required: true },
    commandId: { type: Schema.Types.ObjectId, default: null },
    lastCheckInAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { collection: 'deviceEnrollments', timestamps: true, versionKey: false },
);

schema.index({ orgId: 1, status: 1 });
schema.plugin(tenantGuard);

export const DeviceRecovery = recoveryDb.model('DeviceRecovery', schema);
