import { model, Schema } from 'mongoose';

/** Small, optimized retailer logos are stored separately so normal organization/session reads stay lightweight. */
const orgLogoSchema = new Schema(
  {
    /** The organization's _id is also the logo document's _id: one logo per retailer. */
    _id: { type: Schema.Types.ObjectId, required: true },
    contentType: { type: String, enum: ['image/webp', 'image/png', 'image/jpeg'], required: true },
    data: { type: Buffer, required: true, select: false },
  },
  { collection: 'org_logos', timestamps: true, versionKey: false },
);

export const OrgLogo = model('OrgLogo', orgLogoSchema);
