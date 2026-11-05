import { model, Schema } from 'mongoose';
import { PAYMENT_KINDS, PAYMENT_METHODS } from '@shop/shared';
import { tenantGuard } from '../db/tenant_guard';

const allocationSchema = new Schema(
  {
    installmentId: { type: Schema.Types.ObjectId, required: true },
    number: { type: Number, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

/** Money received against a contract. Never deleted: a mistake is voided, which reverses its allocations. */
const paymentSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    /** Where the money was received; may differ from the selling branch. */
    branchId: { type: Schema.Types.ObjectId, required: true },
    contractId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, required: true },
    customerName: { type: String, required: true },
    deviceLabel: { type: String, required: true },
    kind: { type: String, enum: PAYMENT_KINDS, required: true },
    amount: { type: Number, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    reference: { type: String, default: '' },
    /** Printed on the receipt; counts up per branch. */
    receiptNumber: { type: Number, required: true },
    allocations: { type: [allocationSchema], default: [] },
    receivedBy: { type: Schema.Types.ObjectId, required: true },
    receivedByName: { type: String, required: true },
    /** "YYYY-MM-DD" in Pakistan time: the day it counts towards in collections. */
    receivedOn: { type: String, required: true },
    /** The client's one-time key for this request; a retry with it returns this payment instead of a second one. */
    idempotencyKey: { type: String, default: null },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, default: null },
    voidReason: { type: String, default: '' },
  },
  { collection: 'payments', timestamps: true, versionKey: false },
);

paymentSchema.index({ orgId: 1, contractId: 1 }); // a contract's ledger
paymentSchema.index({ orgId: 1, customerId: 1, contractId: 1, _id: -1 }); // customer-app cursor pages
paymentSchema.index({ orgId: 1, receivedOn: 1, branchId: 1 }); // a day's collections, one branch or all
paymentSchema.index({ orgId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

paymentSchema.virtual('branch', { ref: 'Branch', localField: 'branchId', foreignField: '_id', justOne: true });

paymentSchema.plugin(tenantGuard);

export const Payment = model('Payment', paymentSchema);
