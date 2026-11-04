import { DEFAULT_LOCK_POLICY, addDays, todayInShops } from '@shop/shared';
import type { Types } from 'mongoose';
import { withTransaction } from '../db/transaction';
import { logger } from '../lib/logger';
import { Contract } from '../models/contract';
import { Installment } from '../models/installment';
import { Org } from '../models/org';

interface OverdueOptions {
  orgId?: Types.ObjectId;
}

/**
 * Daily, just after midnight in Pakistan: installments past their due date become overdue, and, where the owner
 * turned late fees on, one fee is added to each installment still unpaid past the grace days. Safe to run twice.
 */
export async function runOverdueCheck(now = new Date(), { orgId }: OverdueOptions = {}) {
  const today = todayInShops(now);
  let marked = 0;
  let fees = 0;

  const filter = { status: 'active' as const, ...(orgId ? { _id: orgId } : {}) };
  for (const org of await Org.find(filter).lean()) {
    const result = await Installment.updateMany({ orgId: org._id, dueDate: { $lt: today }, status: { $in: ['pending', 'partial'] } }, { $set: { status: 'overdue' } });
    marked += result.modifiedCount;

    const fee = org.lateFee?.enabled ? (org.lateFee.amount ?? 0) : 0;
    if (!fee) continue;
    const { graceDays } = { ...DEFAULT_LOCK_POLICY, ...org.lockPolicy };
    const cutoff = addDays(today, -graceDays);
    const feeDue = await Installment.find({
      orgId: org._id,
      status: 'overdue',
      lateFee: 0,
      dueDate: { $lt: cutoff },
    }).select('_id contractId').lean();

    // Group by contract so several late installments share one transaction and two writes.
    const byContract = new Map<string, { contractId: typeof feeDue[number]['contractId']; ids: typeof feeDue[number]['_id'][] }>();
    for (const installment of feeDue) {
      const key = String(installment.contractId);
      const group = byContract.get(key) ?? { contractId: installment.contractId, ids: [] };
      group.ids.push(installment._id);
      byContract.set(key, group);
    }

    for (const { contractId, ids } of byContract.values()) {
      fees += await withTransaction(async () => {
        // Recheck eligibility inside the transaction: repeat jobs and concurrent runs cannot charge twice.
        const charged = await Installment.updateMany(
          { orgId: org._id, contractId, _id: { $in: ids }, status: 'overdue', lateFee: 0, dueDate: { $lt: cutoff } },
          { $set: { lateFee: fee } },
        );
        if (charged.modifiedCount) {
          await Contract.updateOne(
            { _id: contractId, orgId: org._id },
            { $inc: { lateFees: charged.modifiedCount * fee } },
          );
        }
        return charged.modifiedCount;
      });
    }
  }
  logger.info('Overdue check done', { today, marked, fees });
  return { today, marked, fees };
}
