import {
  DEFAULT_LOCK_POLICY,
  daysOverdue,
  formatRupees,
  overdueAmount,
  shouldLock,
  todayInShops,
  type DueInstallment,
  type LockPolicy,
} from '@shop/shared';
import type { Types } from 'mongoose';
import { recordSystemAudit } from '../lib/audit';
import { queueCommand } from '../lib/locks';
import { logger } from '../lib/logger';
import { Contract } from '../models/contract';
import { Device } from '../models/device';
import { DeviceCommand, OPEN_STATUSES } from '../models/device_command';
import { Installment } from '../models/installment';
import { Org } from '../models/org';

const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', hourCycle: 'h23' });

interface AutoLockOptions {
  anyHour?: boolean;
  orgId?: Types.ObjectId;
}

/**
 * Batch candidate data once per retailer. Previously each late contract performed three or four extra
 * reads (contract, schedule, device and pending command). This uses indexed, tenant-scoped finds,
 * a map for schedules, and the database's unique open-command constraint for concurrency safety.
 */
async function lockEligibleContracts(orgId: Types.ObjectId, policy: LockPolicy, today: string) {
  const late = await Installment.distinct('contractId', {
    orgId,
    status: { $in: ['pending', 'partial', 'overdue'] },
    dueDate: { $lt: today },
  });
  if (!late.length) return 0;

  const contracts = await Contract.find({ orgId, _id: { $in: late }, status: 'active' }).lean();
  if (!contracts.length) return 0;

  const contractIds = contracts.map((contract) => contract._id);
  const deviceIds = contracts.map((contract) => contract.deviceId);
  const [installments, devices, commands] = await Promise.all([
    Installment.find({ orgId, contractId: { $in: contractIds } }).select('contractId dueDate amount lateFee paidAmount').lean(),
    Device.find({ orgId, _id: { $in: deviceIds } }).select('lockState').lean(),
    DeviceCommand.find({ orgId, deviceId: { $in: deviceIds }, status: { $in: [...OPEN_STATUSES] } }).select('deviceId').lean(),
  ]);

  const schedules = new Map<string, DueInstallment[]>();
  for (const installment of installments) {
    const key = String(installment.contractId);
    const schedule = schedules.get(key) ?? [];
    schedule.push(installment);
    schedules.set(key, schedule);
  }

  const locked = new Set(devices.filter((device) => device.lockState === 'locked').map((device) => String(device._id)));
  const occupied = new Set(commands.map((command) => String(command.deviceId)));
  let queued = 0;

  for (const contract of contracts) {
    const schedule = schedules.get(String(contract._id)) ?? [];
    if (!shouldLock({ policy, installments: schedule, today, pausedUntil: contract.autoLockPausedUntil ?? null })) continue;

    const deviceKey = String(contract.deviceId);
    if (locked.has(deviceKey) || occupied.has(deviceKey)) continue;

    const reason = `${daysOverdue(schedule, today)} days overdue, ${formatRupees(overdueAmount(schedule, today))} owed`;
    const status = policy.mode === 'automatic' ? 'pending' : 'proposed';
    // The unique partial index on open commands prevents two jobs from queueing one phone twice.
    const command = await queueCommand({ contract, type: 'lock', status, source: 'auto', reason });
    occupied.add(deviceKey);
    await recordSystemAudit(orgId, {
      action: policy.mode === 'automatic' ? 'lock.queued' : 'lock.proposed',
      entity: 'contract',
      entityId: contract._id,
      branchId: contract.branchId,
      summary: `${policy.mode === 'automatic' ? 'Queued' : 'Proposed'} a lock for ${contract.customerName}'s ${contract.deviceLabel}: ${reason}`,
      metadata: { commandId: command._id },
    });
    queued += 1;
  }

  return queued;
}

/**
 * Hourly: each retailer whose lock hour it is (Pakistan time) queues or proposes eligible locks.
 * All read work is batched per retailer; the command/audit writes remain individual and atomic.
 */
export async function runAutoLock(now = new Date(), { anyHour = false, orgId }: AutoLockOptions = {}) {
  const today = todayInShops(now);
  const hour = Number(hourFormat.format(now));
  let queued = 0;
  const filter = { status: 'active' as const, ...(orgId ? { _id: orgId } : {}) };

  for (const org of await Org.find(filter).lean()) {
    const policy: LockPolicy = { ...DEFAULT_LOCK_POLICY, ...org.lockPolicy };
    if (policy.mode === 'off' || (!anyHour && policy.lockHour !== hour)) continue;
    queued += await lockEligibleContracts(org._id, policy, today);
  }

  logger.info('Auto-lock done', { today, hour, queued });
  return { today, queued };
}
