import { model, Schema } from 'mongoose';

const schema = new Schema({
  _id: { type: String, required: true }, // SHA-256 of the token: bounded unique index, no token in logs/URLs.
  accountId: { type: Schema.Types.ObjectId, required: true },
  sessionId: { type: String, required: true },
  token: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
}, { collection: 'customer_push_tokens', timestamps: true, versionKey: false });
schema.index({ accountId: 1, sessionId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const CustomerPushToken = model('CustomerPushToken', schema);
