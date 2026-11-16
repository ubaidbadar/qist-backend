import { model, Schema } from 'mongoose';

const schema = new Schema({
  kind: { type: String, enum: ['local', 'remote'], required: true },
  nonceHash: { type: String, required: true },
  challenge: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  state: { type: String, enum: ['pending', 'approved', 'denied', 'claimed', 'cancelled'], default: 'pending' },
  deviceId: { type: Schema.Types.ObjectId, default: null },
  orgId: { type: Schema.Types.ObjectId, default: null },
  enrollmentHash: { type: String, default: null, select: false },
  keyId: { type: String, default: null },
  phone: { type: String, default: null, select: false },
  numberHash: { type: String, default: null, select: false },
  attempts: { type: Number, default: 0 },
  accountId: { type: Schema.Types.ObjectId, default: null },
  accountVersion: { type: Number, default: null },
}, { collection: 'device_signins', timestamps: true, versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ deviceId: 1, state: 1, expiresAt: 1 });
schema.index({ phone: 1, createdAt: -1 });
export const DeviceSignin = model('DeviceSignin', schema);

const limitSchema = new Schema({ _id: { type: String, required: true }, count: { type: Number, default: 0 }, expiresAt: { type: Date, required: true } }, { collection: 'device_signin_limits', versionKey: false });
limitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DeviceSigninLimit = model('DeviceSigninLimit', limitSchema);
