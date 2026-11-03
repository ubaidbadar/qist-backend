import { can } from '@shop/shared';
import { Types } from 'mongoose';
import { Branch } from '../models/branch';
import type { AuthUser } from './auth_user';
import { fieldDetails, ForbiddenError, ValidationError } from './errors';

/**
 * Filter for the records a user may see: their organization, and only their assigned branches unless their role
 * sees every branch. `field` is where the branch id is stored: `branchId` on most records, `_id` on branches.
 */
export function scopeFilter(auth: AuthUser, field: 'branchId' | '_id' = 'branchId') {
  if (can(auth.role, 'branches.all')) return { orgId: auth.orgId };
  return { orgId: auth.orgId, [field]: { $in: auth.branchIds } };
}

/** Whether the user works at this branch (owners work at every branch). */
export const worksAt = (auth: AuthUser, branchId: Types.ObjectId | string) =>
  can(auth.role, 'branches.all') || auth.branchIds.some((id) => id.equals(branchId));

/**
 * A branch id sent by the client for new work (a sale, a stock entry, a transfer target): it must be an active
 * branch of the organization that the user works at. `field` names the form field for the error message.
 */
export async function usableBranch(auth: AuthUser, branchId: string, field: string) {
  if (!worksAt(auth, branchId)) throw new ForbiddenError("You don't work at that branch");
  if (!(await Branch.exists({ _id: branchId, orgId: auth.orgId, active: true }))) {
    throw new ValidationError('Choose an active branch', fieldDetails(field, 'Unknown or inactive branch'));
  }
  return new Types.ObjectId(branchId);
}
