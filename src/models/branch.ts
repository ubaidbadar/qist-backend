import { model, Schema } from 'mongoose';
import { tenantGuard } from '../db/tenant_guard';

const branchSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '' },
    address: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  { collection: 'branches', timestamps: true, versionKey: false },
);

branchSchema.plugin(tenantGuard);

export const Branch = model('Branch', branchSchema);
