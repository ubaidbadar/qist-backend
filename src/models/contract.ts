import { model, Schema } from 'mongoose';
import { CONTRACT_STATUSES, FREQUENCIES } from '@shop/shared';
import { tenantGuard } from '../db/tenant_guard';

/**
 * A phone sold on installments. The customer's name and CNIC and the phone's label and IMEIs are copied in at sale,
 * so the contract reads the same later even if the customer or phone record is edited. Amounts are paisa.
 */
const contractSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    branchId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, required: true },
    customerName: { type: String, required: true },
    customerCnic: { type: String, required: true },
    deviceId: { type: Schema.Types.ObjectId, required: true },
    deviceLabel: { type: String, required: true },
    imeis: { type: [String], required: true },
    planId: { type: Schema.Types.ObjectId, default: null },
    cashPrice: { type: Number, required: true },
    downPayment: { type: Number, required: true },
    markupPercent: { type: Number, required: true },
    markupBasis: { type: String, enum: ['financed', 'cash_price'], default: 'financed' },
    financedAmount: { type: Number, required: true },
    markupAmount: { type: Number, required: true },
    totalPayable: { type: Number, required: true },
    count: { type: Number, required: true },
    frequency: { type: String, enum: FREQUENCIES, required: true },
    firstDueDate: { type: String, required: true },
    paidTotal: { type: Number, default: 0 },
    lateFees: { type: Number, default: 0 },
    autoLockPausedUntil: { type: String, default: null },
    pauseReason: { type: String, default: '' },
    status: { type: String, enum: CONTRACT_STATUSES, default: 'active' },
    cancelReason: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { collection: 'contracts', timestamps: true, versionKey: false },
);

contractSchema.index({ orgId: 1, branchId: 1, _id: -1 }); // one branch's sales, newest first
contractSchema.index({ orgId: 1, _id: -1 }); // all branches (owners), newest first
contractSchema.index({ orgId: 1, customerId: 1 }); // a customer's contracts
contractSchema.index({ orgId: 1, deviceId: 1, status: 1, _id: -1 }); // latest active contract on a checking-in phone

contractSchema.virtual('branch', { ref: 'Branch', localField: 'branchId', foreignField: '_id', justOne: true });

contractSchema.plugin(tenantGuard);

export const Contract = model('Contract', contractSchema);
