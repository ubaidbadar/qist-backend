import type { Types } from 'mongoose';
import { acrossTenants } from '../db/tenant_guard';
import { Device } from '../models/device';
import { readSecretToken, secretMatches } from './tokens';

/** The enrolled phone behind a device-API request, available as `c.var.device`. */
export interface EnrolledDevice {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  branchId: Types.ObjectId;
}

/**
 * Resolves a `<deviceId>.<secret>` bearer token to the enrolled phone, or null. The device id is looked up before
 * the organization is known (the token names the phone), so it is one of the few `acrossTenants` lookups; every
 * query afterwards uses the phone's own `orgId`.
 */
export async function deviceFromToken(token: string | undefined): Promise<EnrolledDevice | null> {
  const parsed = readSecretToken(token);
  if (!parsed) return null;
  const device = await acrossTenants(
    Device.findById(parsed._id).select('orgId branchId enrollment.secretHash'),
  ).lean();
  if (!device?.enrollment?.secretHash || !secretMatches(parsed.secret, device.enrollment.secretHash)) return null;
  return { _id: device._id, orgId: device.orgId, branchId: device.branchId };
}
