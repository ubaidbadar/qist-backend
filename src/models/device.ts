import { model, Schema } from 'mongoose';
import { DEVICE_LOCK_STATES, DEVICE_STOCK_STATUSES } from '@shop/shared';
import { tenantGuard } from '../db/tenant_guard';

/** A phone: in a branch's stock, then sold on installments, then released once paid off. */
const deviceSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    /** The branch that holds it; changed only by a transfer. */
    branchId: { type: Schema.Types.ObjectId, required: true },
    brand: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    /** One per SIM slot; each is unique within the retailer. */
    imeis: { type: [String], required: true },
    storage: { type: String, default: '' },
    color: { type: String, default: '' },
    ptaApproved: { type: Boolean, default: true },
    /** What the shop paid, in paisa. Owners only: loaded with `.select('+costPrice')`. */
    costPrice: { type: Number, default: null, select: false },
    stockStatus: { type: String, enum: DEVICE_STOCK_STATUSES, default: 'in_stock' },
    /** Changes when the device app confirms a lock or unlock (Phase 2). */
    lockState: { type: String, enum: DEVICE_LOCK_STATES, default: 'unlocked' },
    /** A one-time provisioning QR waiting to be scanned at the counter; cleared once redeemed or expired. */
    enrollToken: {
      type: new Schema(
        {
          secretHash: { type: String, required: true, select: false },
          expiresAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Set once the device app redeems the QR: the phone's long-lived credential and its last contact. */
    enrollment: {
      type: new Schema(
        {
          secretHash: { type: String, required: true, select: false },
          enrolledAt: { type: Date, required: true },
          lastCheckInAt: { type: Date, default: null },
          pushToken: { type: String, default: '' },
          appVersion: { type: String, default: '' },
          platform: { type: String, default: 'android' },
          authPublicKey: { type: String, default: null, select: false },
          authKeyId: { type: String, default: null },
          customerApp: {
            type: new Schema({
              status: { type: String, enum: ['pending', 'downloading', 'installing', 'installed', 'failed', 'needs_attention', 'not_configured'], required: true },
              versionCode: { type: Number },
              detailCode: { type: String },
              reportedAt: { type: Date, required: true },
            }, { _id: false }),
            default: undefined,
          },
        },
        { _id: false },
      ),
      default: null,
    },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { collection: 'devices', timestamps: true, versionKey: false },
);

deviceSchema.index({ orgId: 1, imeis: 1 }, { unique: true }); // an IMEI exists once per retailer; IMEI search
deviceSchema.index({ orgId: 1, branchId: 1, _id: -1 }); // one branch's stock, newest first
deviceSchema.index({ orgId: 1, _id: -1 }); // all branches' stock (owners), newest first

/** `.populate({ path: 'branch', ... })` adds `{ _id, name }` of the branch. */
deviceSchema.virtual('branch', { ref: 'Branch', localField: 'branchId', foreignField: '_id', justOne: true });

deviceSchema.plugin(tenantGuard);

export const Device = model('Device', deviceSchema);
