import { model, Schema } from 'mongoose';

export const EMAIL_TOKEN_PURPOSES = ['verify_email', 'reset_password'] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

/** The token inside an emailed link ("<_id>.<secret>", like refresh tokens). Works once, then expires. */
const emailTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    purpose: { type: String, enum: EMAIL_TOKEN_PURPOSES, required: true },
    secretHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 }, // MongoDB deletes it once expired
    usedAt: { type: Date, default: null },
  },
  { collection: 'emailTokens', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

export const EmailToken = model('EmailToken', emailTokenSchema);
