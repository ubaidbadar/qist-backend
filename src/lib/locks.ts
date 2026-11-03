import { DEFAULT_LOCK_POLICY, shouldUnlock, todayInShops, type CommandSource, type CommandType, type LockPolicy } from '@shop/shared';
import type { Types } from 'mongoose';
import { Device } from '../models/device';
import { DeviceCommand, OPEN_STATUSES } from '../models/device_command';
import { Installment } from '../models/installment';
import { Org } from '../models/org';
import type { AuthUser } from './auth_user';

/** The organization's lock policy with defaults filled in (older documents may lack some fields). */
export async function policyOf(orgId: Types.ObjectId): Promise<LockPolicy> {
  const org = await Org.findById(orgId).select('lockPolicy').lean();
  return { ...DEFAULT_LOCK_POLICY, ...org?.lockPolicy };
}

interface ContractRef {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  branchId: Types.ObjectId;
  deviceId: Types.ObjectId;
  customerName: string;
  deviceLabel: string;
}

interface NewCommand {
  contract: ContractRef;
  type: CommandType;
  status: 'proposed' | 'pending';
  source: CommandSource;
  reason: string;
  /** Who asked; the system when absent. */
  by?: AuthUser;
}

/** Queues a command for the contract's phone. The unique index refuses a second open one for the same phone. */
export function queueCommand({ contract, type, status, source, reason, by }: NewCommand) {
  return DeviceCommand.create({
    orgId: contract.orgId,
    branchId: contract.branchId,
    deviceId: contract.deviceId,
    contractId: contract._id,
    customerName: contract.customerName,
    deviceLabel: contract.deviceLabel,
    type,
    status,
    source,
    reason,
    requestedBy: by?._id ?? null,
    requestedByName: by?.fullName ?? 'System',
  });
}

export const openCommandOf = (orgId: Types.ObjectId, deviceId: Types.ObjectId) =>
  DeviceCommand.findOne({ orgId, deviceId, status: { $in: [...OPEN_STATUSES] } }).lean();

/** Withdraws a lock that hasn't reached the phone yet. */
export const cancelOpenLock = (orgId: Types.ObjectId, deviceId: Types.ObjectId, reason: string, by?: AuthUser) =>
  DeviceCommand.updateOne(
    { orgId, deviceId, type: 'lock', status: { $in: [...OPEN_STATUSES] } },
    { $set: { status: 'cancelled', decisionReason: reason, decidedBy: by?._id ?? null, decidedByName: by?.fullName ?? 'System' } },
  );

/**
 * After money comes in (inside the payment's transaction): a paid-off phone is released; otherwise, once nothing
 * is overdue past the policy, a waiting lock is withdrawn and a locked phone is unlocked.
 */
export async function afterPayment(contract: ContractRef & { autoLockPausedUntil?: string | null }, paidOff: boolean) {
  const { orgId, deviceId } = contract;
  if (paidOff) {
    await cancelOpenLock(orgId, deviceId, 'Contract paid off');
    await queueCommand({ contract, type: 'release', status: 'pending', source: 'payment', reason: 'Paid in full' });
    return;
  }

  const installments = await Installment.find({ orgId, contractId: contract._id }).lean();
  const situation = { policy: await policyOf(orgId), installments, today: todayInShops(), pausedUntil: contract.autoLockPausedUntil ?? null };
  if (!shouldUnlock(situation)) return;

  await cancelOpenLock(orgId, deviceId, 'Overdue amount paid');
  const device = await Device.findOne({ _id: deviceId, orgId }).select('lockState').lean();
  if (device?.lockState === 'locked' && !(await openCommandOf(orgId, deviceId))) {
    await queueCommand({ contract, type: 'unlock', status: 'pending', source: 'payment', reason: 'Overdue amount paid' });
  }
}
