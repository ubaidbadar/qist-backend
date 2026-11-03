import type { Types } from 'mongoose';
import type { Role } from '@shop/shared';

/** The signed-in user, loaded fresh on every request by `authenticate` and available as `c.var.auth`. */
export interface AuthUser {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  role: Role;
  branchIds: Types.ObjectId[];
  fullName: string;
  email: string;
}

export const authUserOf = ({ _id, orgId, role, branchIds, fullName, email }: AuthUser): AuthUser => ({
  _id,
  orgId,
  role,
  branchIds,
  fullName,
  email,
});
