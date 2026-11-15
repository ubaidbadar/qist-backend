import { model, Schema } from 'mongoose';
import { ROLES } from '@shop/shared';
import { tenantGuard } from '../db/tenant_guard';

const userSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, required: true, index: true },
    /** Unique across all organizations: it is how a person signs in. */
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    /** Never loaded unless asked for with `.select('+passwordHash')`. */
    passwordHash: { type: String, required: true, select: false },
    /** Stable Google OpenID Connect subject; absent for legacy email/password-only accounts. */
    googleSub: { type: String, select: false },
    fullName: { type: String, required: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    /** Branches a manager or staff member works in; empty for the owner, who sees every branch. */
    branchIds: { type: [Schema.Types.ObjectId], default: [] },
    active: { type: Boolean, default: true },
    emailVerifiedAt: { type: Date, default: null },
    mustChangePassword: { type: Boolean, default: false },
    /** Bumped to void every access token at once (password change, deactivation). Hidden like the password. */
    tokenVersion: { type: Number, default: 0, select: false },
    lastLoginAt: { type: Date, default: null },
  },
  { collection: 'users', timestamps: true, versionKey: false },
);

// A Google identity can belong to only one Qist account; sparse keeps legacy accounts out of this index.
userSchema.index({ googleSub: 1 }, { unique: true, sparse: true });

// Safety net for documents not loaded through a query (e.g. one just created): secrets never reach a response.
userSchema.set('toJSON', { transform: (_doc, { passwordHash, googleSub, tokenVersion, ...user }) => user });

userSchema.plugin(tenantGuard);

export const User = model('User', userSchema);
