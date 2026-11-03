import { model, Schema } from 'mongoose';

/**
 * One per sign-in on a device, rotated on every refresh. The browser's cookie holds "<_id>.<secret>": the _id
 * finds this document, the secret proves the cookie is genuine. Belongs to a user, so it has no orgId.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true }, // to sign a user out everywhere
    secretHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 }, // MongoDB deletes it once expired
    revokedAt: { type: Date, default: null },
    /** Revoked because it was exchanged for a newer token, not by logout or theft detection. */
    rotated: { type: Boolean, default: false },
    userAgent: { type: String, default: '' },
  },
  { collection: 'refreshTokens', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

export const RefreshToken = model('RefreshToken', refreshTokenSchema);
