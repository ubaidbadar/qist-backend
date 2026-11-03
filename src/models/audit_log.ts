import { model, Schema } from 'mongoose';
import { tenantGuard } from '../db/tenant_guard';

/** Who did what, and when. Written in the same transaction as the change it records. */
const auditLogSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    branchId: { type: Schema.Types.ObjectId, default: null },
    actor: {
      kind: { type: String, enum: ['user', 'system'], required: true },
      userId: { type: Schema.Types.ObjectId, default: null },
      name: { type: String, required: true },
    },
    action: { type: String, required: true }, // e.g. "branch.created"
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    summary: { type: String, required: true },
    /** Field names and non-personal values only: never CNIC, phone numbers or passwords. */
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  // Its indexes arrive with the audit log screen (M6), shaped by that screen's filters.
  { collection: 'auditLogs', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

auditLogSchema.plugin(tenantGuard);

// Append-only: the model itself refuses to change or remove an entry.
auditLogSchema.pre(
  /^(updateOne|updateMany|replaceOne|findOneAndUpdate|findOneAndReplace|deleteOne|deleteMany|findOneAndDelete)$/,
  () => {
    throw new Error('Audit log entries cannot be changed or deleted');
  },
);

export const AuditLog = model('AuditLog', auditLogSchema);
