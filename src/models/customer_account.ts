import { model, Schema } from 'mongoose';

const resetSchema = new Schema({
  digest: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  sentAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  requestId: { type: String, default: null },
}, { _id: false });
const setupSchema = new Schema({
  digest: { type: String, required: true }, expiresAt: { type: Date, required: true },
  deviceBinding: { type: new Schema({
    accountVersion: { type: Number, required: true },
    deviceId: { type: Schema.Types.ObjectId, required: true }, orgId: { type: Schema.Types.ObjectId, required: true },
    enrollmentHash: { type: String, default: null }, keyId: { type: String, default: null },
  }, { _id: false }), default: undefined },
}, { _id: false });
const sessionSchema = new Schema({ id: { type: String, required: true }, expiresAt: { type: Date, required: true } }, { _id: false });

/** A verified phone identity, independent of retailer staff. Never stores retailer permissions. */
const schema = new Schema({
  phone: { type: String, required: true, unique: true },
  passwordHash: { type: String, default: null, select: false },
  tokenVersion: { type: Number, default: 0, select: false },
  sessions: { type: [sessionSchema], default: [], select: false },
  setup: { type: setupSchema, default: null, select: false },
  reset: { type: resetSchema, default: null, select: false },
  resetWindowStart: { type: Date, default: null, select: false },
  resetSentCount: { type: Number, default: 0, select: false },
  lastResetSentAt: { type: Date, default: null, select: false },
}, { collection: 'customer_accounts', timestamps: true, versionKey: false });

schema.set('toJSON', { transform: (_doc, { _id, phone }) => ({ _id, phone }) });
export const CustomerAccount = model('CustomerAccount', schema);
