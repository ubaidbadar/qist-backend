import { model, Schema } from 'mongoose';
import { tenantGuard } from '../db/tenant_guard';

/** A per-branch sequence, e.g. receipt numbers 1, 2, 3… */
const counterSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    branchId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { collection: 'counters', versionKey: false },
);

counterSchema.index({ orgId: 1, branchId: 1, name: 1 }, { unique: true });
counterSchema.plugin(tenantGuard);

export const Counter = model('Counter', counterSchema);
