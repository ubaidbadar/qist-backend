import { model, Schema } from 'mongoose';
import { FREQUENCIES } from '@shop/shared';
import { tenantGuard } from '../db/tenant_guard';

/** Ready-made terms ("6 months, 25%") the owner sets once for every branch. */
const installmentPlanSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    frequency: { type: String, enum: FREQUENCIES, required: true },
    count: { type: Number, required: true },
    markupPercent: { type: Number, required: true },
    minDownPaymentPercent: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { collection: 'installmentPlans', timestamps: true, versionKey: false },
);

installmentPlanSchema.plugin(tenantGuard);

export const InstallmentPlan = model('InstallmentPlan', installmentPlanSchema);
