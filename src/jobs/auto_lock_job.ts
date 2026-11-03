import { daysOverdue, formatRupees, overdueAmount, shouldLock, todayInShops, type LockPolicy } from '@shop/shared';
import type { Types } from 'mongoose';
import { recordSystemAudit } from '../lib/audit';
import { openCommandOf, policyOf, queueCommand } from '../lib/locks';
import { logger } from '../lib/logger';
import { Contract } from '../models/contract';
import { Device } from '../models/device';
import { Installment } from '../models/installment';
import { Org } from '../models/org';

const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', hourCycle: 'h23' });

/** One contract: queue a lock (or a proposal, in approval mode) if it qualifies and nothing is open for its phone. */
async function considerContract(contractId: Types.ObjectId, orgId: Types.ObjectId, policy: LockPolicy, today: string) {
  const contract = await Contract.findOne({ _id: contractId, orgId, status: 'active' }).lean();
  if (!contract) return false;
  const installments = await Installment.find({ orgId, contractId }).lean();
  if (!shouldLock({ policy, installments, today, pausedUntil: contract.autoLockPausedUntil ?? null })) return false;

  const device = await Device.findOne({ _id: contract.deviceId, orgId }).select('lockState').lean();
  if (device?.lockState === 'locked' || (await openCommandOf(orgId, contract.deviceId))) return false;

  const reason = `${daysOverdue(installments, today)} days overdue, ${formatRupees(overdueAmount(installments, today))} owed`;
  const command = await queueCommand({ contract, type: 'lock', status: policy.mode === 'automatic' ? 'pending' : 'proposed', source: 'auto', reason });
  await recordSystemAudit(orgId, {
    action: policy.mode === 'automatic' ? 'lock.queued' : 'lock.proposed',
    entity: 'contract',
    entityId: contract._id,
    branchId: contract.branchId,
    summary: `${policy.mode === 'automatic' ? 'Queued' : 'Proposed'} a lock for ${contract.customerName}'s ${contract.deviceLabel}: ${reason}`,
    metadata: { commandId: command._id },
  });
  return true;
}

/**
 * Hourly: for each retailer whose lock hour it is (Pakistan time), proposes or queues locks for contracts that
 * qualify under its policy. `anyHour` runs every retailer now (manual or external trigger). Safe to run twice.
 */
export async function runAutoLock(now = new Date(), { anyHour = false } = {}) {
  const today = todayInShops(now);
  const hour = Number(hourFormat.format(now));
  let queued = 0;

  for (const org of await Org.find({ status: 'active' }).select('_id').lean()) {
    const policy = await policyOf(org._id);
    if (policy.mode === 'off' || (!anyHour && policy.lockHour !== hour)) continue;
    const late = await Installment.distinct('contractId', { orgId: org._id, status: { $in: ['pending', 'partial', 'overdue'] }, dueDate: { $lt: today } });
    for (const contractId of late) {
      if (await considerContract(contractId, org._id, policy, today)) queued += 1;
    }
  }
  logger.info('Auto-lock done', { today, hour, queued });
  return { today, queued };
}
