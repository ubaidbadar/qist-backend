import { model, Schema } from 'mongoose';
import { INSTALLMENT_STATUSES } from '@shop/shared';
import { tenantGuard } from '../db/tenant_guard';

/** One due amount of a contract's schedule. `dueDate` is "YYYY-MM-DD" in Pakistan time. */
const installmentSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    branchId: { type: Schema.Types.ObjectId, required: true },
    contractId: { type: Schema.Types.ObjectId, required: true },
    number: { type: Number, required: true },
    dueDate: { type: String, required: true },
    amount: { type: Number, required: true },
    lateFee: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    status: { type: String, enum: INSTALLMENT_STATUSES, default: 'pending' },
  },
  { collection: 'installments', timestamps: true, versionKey: false },
);

installmentSchema.index({ orgId: 1, contractId: 1, number: 1 }); // a contract's schedule, in order
installmentSchema.index({ orgId: 1, status: 1, dueDate: 1 }); // organization-wide overdue jobs
installmentSchema.index({ orgId: 1, branchId: 1, status: 1, dueDate: 1 }); // branch-scoped overdue dashboard

installmentSchema.plugin(tenantGuard);

export const Installment = model('Installment', installmentSchema);
