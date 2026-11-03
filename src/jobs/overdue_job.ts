import { addDays, todayInShops } from '@shop/shared';
import { withTransaction } from '../db/transaction';
import { logger } from '../lib/logger';
import { Contract } from '../models/contract';
import { Installment } from '../models/installment';
import { Org } from '../models/org';
import { policyOf } from '../lib/locks';

/**
 * Daily, just after midnight in Pakistan: installments past their due date become overdue, and, where the owner
 * turned late fees on, one fee is added to each installment still unpaid past the grace days. Safe to run twice.
 */
export async function runOverdueCheck(now = new Date()) {
  const today = todayInShops(now);
  let marked = 0;
  let fees = 0;

  for (const org of await Org.find({ status: 'active' }).select('lateFee').lean()) {
    const result = await Installment.updateMany({ orgId: org._id, dueDate: { $lt: today }, status: { $in: ['pending', 'partial'] } }, { $set: { status: 'overdue' } });
    marked += result.modifiedCount;

    const fee = org.lateFee?.enabled ? (org.lateFee.amount ?? 0) : 0;
    if (!fee) continue;
    const { graceDays } = await policyOf(org._id);
    const feeDue = await Installment.find({ orgId: org._id, status: 'overdue', lateFee: 0, dueDate: { $lt: addDays(today, -graceDays) } }).lean();
    for (const installment of feeDue) {
      await withTransaction(async () => {
        const charged = await Installment.updateOne({ _id: installment._id, orgId: org._id, lateFee: 0 }, { $set: { lateFee: fee } });
        if (charged.modifiedCount) await Contract.updateOne({ _id: installment.contractId, orgId: org._id }, { $inc: { lateFees: fee } });
      });
      fees += 1;
    }
  }
  logger.info('Overdue check done', { today, marked, fees });
  return { today, marked, fees };
}
