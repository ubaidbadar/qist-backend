import { Types, type ClientSession } from 'mongoose';
import { DEVICE_CHECKIN_SECONDS, type DeviceCheckin } from '@shop/shared';
import { acrossTenants } from '../db/tenant_guard';
import { Device } from '../models/device';
import { DeviceRecovery } from '../models/device_recovery';
import { readSecretToken, secretMatches } from './tokens';

export interface RecoveryEnrollment {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  branchId: Types.ObjectId;
  status: 'active' | 'revoked' | 'release_requested' | 'released';
  commandId: Types.ObjectId | null;
  pushToken: string;
  lastCheckInAt: Date | null;
}

/**
 * Recovery is never anonymous: the device must present the original 256-bit bearer secret.
 * Comparing against the separately retained HMAC is essential. The stable environment
 * secret alone cannot verify a lost, randomly generated enrollment credential.
 */
export async function recoveryFromToken(token: string): Promise<RecoveryEnrollment | null> {
  const parsed = readSecretToken(token);
  if (!parsed) return null;
  const recovery = await acrossTenants(
    DeviceRecovery.findById(parsed._id).select('+secretHash +pushToken'),
  ).lean<RecoveryEnrollment & { secretHash: string }>();
  if (!recovery || !secretMatches(parsed.secret, recovery.secretHash)) return null;
  return recovery;
}

/** Called inside the original enrollment transaction. */
export async function registerRecovery(
  device: { _id: Types.ObjectId; orgId: Types.ObjectId; branchId: Types.ObjectId },
  secretHash: string,
  pushToken: string,
  session: ClientSession,
) {
  await DeviceRecovery.findOneAndUpdate(
    { _id: device._id, orgId: device.orgId },
    {
      $set: {
        branchId: device.branchId,
        secretHash,
        pushToken,
        status: 'active',
        commandId: null,
        lastCheckInAt: null,
        releasedAt: null,
      },
      $setOnInsert: { orgId: device.orgId },
    },
    { upsert: true, session },
  );
}

/**
 * Existing enrolled devices get their survival record on their next authenticated check-in.
 * Never overwrite an earlier release/revocation request with an ordinary check-in.
 */
export async function mirrorRecoveryCheckin(
  device: {
    _id: Types.ObjectId;
    orgId: Types.ObjectId;
    branchId: Types.ObjectId;
    enrollmentHash: string;
  },
  pushToken: string | undefined,
  session: ClientSession,
) {
  const now = new Date();
  await DeviceRecovery.updateOne(
    { _id: device._id, orgId: device.orgId, status: 'active' },
    {
      $set: {
        branchId: device.branchId,
        lastCheckInAt: now,
        ...(pushToken === undefined ? {} : { pushToken }),
      },
      $setOnInsert: {
        orgId: device.orgId,
        secretHash: device.enrollmentHash,
        status: 'active',
      },
    },
    { upsert: true, session },
  );
}

/** A deliberate revocation must not become an orphan-recovery exception. */
export async function revokeRecovery(deviceId: Types.ObjectId, orgId: Types.ObjectId, session: ClientSession) {
  await DeviceRecovery.updateOne(
    { _id: deviceId, orgId },
    { $set: { status: 'revoked', commandId: null, pushToken: '' } },
    { session },
  );
}

/** Normal paid-off releases invalidate the survival verifier too. */
export async function recordNormalRelease(deviceId: Types.ObjectId, orgId: Types.ObjectId, session: ClientSession) {
  await DeviceRecovery.updateOne(
    { _id: deviceId, orgId },
    { $set: { status: 'released', pushToken: '', releasedAt: new Date() } },
    { session },
  );
}

/**
 * This function has NO HTTP route. Only the interactive SSH utility may request a
 * recovery release, and only when the business device record is genuinely absent.
 */
export async function authorizeOrphanRelease(deviceId: Types.ObjectId): Promise<RecoveryEnrollment | null> {
  const primary = await acrossTenants(Device.findById(deviceId).select('_id')).lean();
  if (primary) throw new Error('ABORTED: device still exists in the business database');
  const existing = await acrossTenants(DeviceRecovery.findById(deviceId).select('+pushToken')).lean();
  if (!existing || existing.status !== 'active') return null;

  const commandId = new Types.ObjectId();
  const updated = await DeviceRecovery.findOneAndUpdate(
    { _id: deviceId, orgId: existing.orgId, status: 'active' },
    { $set: { status: 'release_requested', commandId } },
    { returnDocument: 'after' },
  ).select('+pushToken').lean<RecoveryEnrollment>();
  return updated;
}

/** The installed APK already recognizes the `release` command without an update. */
export function orphanReleaseCheckin(recovery: RecoveryEnrollment): DeviceCheckin {
  if (recovery.status !== 'release_requested' || !recovery.commandId) {
    throw new Error('Recovery release is not authorized');
  }
  return {
    lockState: 'unlocked',
    lockScreen: {
      locked: false,
      customerName: '',
      deviceLabel: '',
      amountDue: 0,
      nextDueDate: null,
      branchName: '',
      branchPhone: '',
      message: 'Device management recovery authorized.',
    },
    commands: [{ _id: String(recovery.commandId), type: 'release' }],
    checkInSeconds: DEVICE_CHECKIN_SECONDS,
    customerAppRelease: null,
  };
}

/**
 * The check-in response is repeated until the installed app acknowledges it.
 * Acknowledgements are idempotent because Android retries Owner removal after
 * a process interruption even when the server has already recorded the result.
 */
export async function acknowledgeOrphanRelease(
  recovery: RecoveryEnrollment,
  commandId: string,
  outcome: 'applied' | 'failed',
): Promise<'acknowledged' | 'failed' | 'not_found'> {
  if (!recovery.commandId || String(recovery.commandId) !== commandId ||
    (recovery.status !== 'release_requested' && recovery.status !== 'released')) {
    return 'not_found';
  }
  if (outcome === 'failed') return 'failed';
  await DeviceRecovery.updateOne(
    { _id: recovery._id, orgId: recovery.orgId, commandId: recovery.commandId, status: 'release_requested' },
    { $set: { status: 'released', pushToken: '', releasedAt: new Date() } },
  );
  return 'acknowledged';
}
