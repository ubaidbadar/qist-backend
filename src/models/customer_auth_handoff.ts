import { model, Schema } from 'mongoose';

/** A short-lived, one-use bridge. Raw tickets/nonces never reach MongoDB. */
const schema = new Schema({
  ticketHash: { type: String, required: true, unique: true },
  nonceHash: { type: String, required: true },
  phone: { type: String, required: true },
  orgId: { type: Schema.Types.ObjectId, required: true },
  deviceId: { type: Schema.Types.ObjectId, required: true },
  expiresAt: { type: Date, required: true },
  enrollmentHash: { type: String, default: null, select: false },
  keyId: { type: String, default: null },
  accountId: { type: Schema.Types.ObjectId, default: null },
  accountVersion: { type: Number, default: null },
  consumedAt: { type: Date, default: null },
}, { collection: 'customer_auth_handoffs', timestamps: true, versionKey: false });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ deviceId: 1, createdAt: -1 });

export const CustomerAuthHandoff = model('CustomerAuthHandoff', schema);
