import { model, Schema } from 'mongoose';
import { tenantGuard } from '../db/tenant_guard';

const guarantorSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    cnic: { type: String, required: true },
    phone: { type: String, required: true },
    relation: { type: String, default: '' },
  },
  { _id: false },
);

/** A buyer. Belongs to the organization, so every branch finds the same person. */
const customerSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true },
    homeBranchId: { type: Schema.Types.ObjectId, required: true },
    fullName: { type: String, required: true, trim: true },
    fatherName: { type: String, default: '' },
    /** 13 digits; one customer per CNIC within a retailer. */
    cnic: { type: String, required: true },
    /** 03XXXXXXXXX */
    phone: { type: String, required: true },
    altPhone: { type: String, default: '' },
    address: { type: String, required: true },
    notes: { type: String, default: '' },
    guarantors: { type: [guarantorSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { collection: 'customers', timestamps: true, versionKey: false },
);

customerSchema.index({ orgId: 1, cnic: 1 }, { unique: true }); // no duplicate customers; CNIC search
customerSchema.index({ phone: 1, orgId: 1 }); // verified customer-app identity across its retailers
customerSchema.index({ orgId: 1, _id: -1 }); // newest-first pages; name and mobile search within the retailer

/** `.populate({ path: 'homeBranch', ... })` adds `{ _id, name }` of the home branch. */
customerSchema.virtual('homeBranch', { ref: 'Branch', localField: 'homeBranchId', foreignField: '_id', justOne: true });

customerSchema.plugin(tenantGuard);

export const Customer = model('Customer', customerSchema);
