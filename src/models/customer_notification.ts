import { model, Schema } from 'mongoose';

const schema = new Schema({
  accountId: { type: Schema.Types.ObjectId, required: true },
  contractId: { type: Schema.Types.ObjectId, required: true },
  eventKey: { type: String, required: true },
  kind: { type: String, enum: ['payment', 'payment_voided', 'phone_status', 'due', 'plan_changed'], required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  readAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: () => new Date(0) },
  expiresAt: { type: Date, required: true },
}, { collection: 'customer_notifications', timestamps: true, versionKey: false });
schema.index({ accountId: 1, eventKey: 1 }, { unique: true });
schema.index({ accountId: 1, _id: -1 });
schema.index({ deliveredAt: 1, nextAttemptAt: 1, leaseUntil: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const CustomerNotification = model('CustomerNotification', schema);
