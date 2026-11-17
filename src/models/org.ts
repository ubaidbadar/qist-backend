import { model, Schema } from 'mongoose';
import { DEFAULT_LOCK_POLICY, LOCK_MODES, ORG_STATUSES } from '@shop/shared';

/** A retailer. Its _id is the tenant id that every other record carries as `orgId`. */
const orgSchema = new Schema(
  {
    documentPolicy: { type: Schema.Types.Mixed, default: undefined },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ORG_STATUSES, required: true, default: 'active' },
    /** Updated when the optional logo is replaced; used for cache-busting its public URL. */
    logoUpdatedAt: { type: Date, default: null },
    paymentMethods: { type: [new Schema({
      id: { type: String, required: true },
      kind: { type: String, enum: ['cash', 'easypaisa', 'jazzcash', 'bank'], required: true },
      enabled: { type: Boolean, default: true },
      accountTitle: String,
      accountNumber: String,
      bankName: String,
    }, { _id: false })], default: [] },
    /** When phones are locked (docs/plan.md §5). Read through `policyOf`, which fills in defaults. */
    lockPolicy: {
      mode: { type: String, enum: LOCK_MODES, default: DEFAULT_LOCK_POLICY.mode },
      graceDays: { type: Number, default: DEFAULT_LOCK_POLICY.graceDays },
      lockHour: { type: Number, default: DEFAULT_LOCK_POLICY.lockHour },
      minOverdue: { type: Number, default: DEFAULT_LOCK_POLICY.minOverdue },
      unlockOnPayment: { type: Boolean, default: DEFAULT_LOCK_POLICY.unlockOnPayment },
    },
    /** A fixed fee added once to an installment that stays unpaid past the grace days. */
    lateFee: {
      enabled: { type: Boolean, default: false },
      amount: { type: Number, default: 0 },
    },
  },
  { collection: 'orgs', timestamps: true, versionKey: false },
);

export const Org = model('Org', orgSchema);
