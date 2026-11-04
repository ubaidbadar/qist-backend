import { formatRupees, overdueAmount, todayInShops, type DueInstallment, type LockScreen } from '@shop/shared';
import type { Types } from 'mongoose';
import { Contract } from '../models/contract';

interface DeviceRef {
  orgId: Types.ObjectId;
  deviceId: Types.ObjectId;
  lockState: 'unlocked' | 'locked';
}

interface LockScreenContract {
  customerName: string;
  deviceLabel: string;
  installments: DueInstallment[];
  branch: { name: string; phone: string } | null;
}

/** The earliest installment that still owes money, or null when the schedule is clear. */
const nextUnpaid = (installments: DueInstallment[]) =>
  installments
    .filter((i) => i.amount + i.lateFee > i.paidAmount)
    .map((i) => i.dueDate)
    .sort()[0] ?? null;

/**
 * The phone receives up-to-date amounts and retailer details on every check-in. One bounded
 * aggregation reads its latest active contract, installment schedule, and branch instead of
 * three sequential/parallel database requests. Both lookups are explicitly tenant scoped.
 */
export async function lockScreenFor({ orgId, deviceId, lockState }: DeviceRef): Promise<LockScreen> {
  const [contract] = await Contract.aggregate<LockScreenContract>([
    { $match: { orgId, deviceId, status: 'active' } },
    { $sort: { _id: -1 } },
    { $limit: 1 },
    {
      $lookup: {
        from: 'installments',
        let: { contractId: '$_id' },
        pipeline: [
          { $match: { orgId, $expr: { $eq: ['$contractId', '$$contractId'] } } },
          { $project: { dueDate: 1, amount: 1, lateFee: 1, paidAmount: 1 } },
        ],
        as: 'installments',
      },
    },
    {
      $lookup: {
        from: 'branches',
        let: { branchId: '$branchId' },
        pipeline: [
          { $match: { orgId, $expr: { $eq: ['$_id', '$$branchId'] } } },
          { $project: { name: 1, phone: 1 } },
        ],
        as: 'branches',
      },
    },
    {
      $project: {
        customerName: 1,
        deviceLabel: 1,
        installments: 1,
        branch: { $ifNull: [{ $arrayElemAt: ['$branches', 0] }, null] },
      },
    },
  ]);
  if (!contract) {
    return { locked: lockState === 'locked', customerName: '', deviceLabel: '', amountDue: 0, nextDueDate: null, branchName: '', branchPhone: '', message: '' };
  }

  const amountDue = overdueAmount(contract.installments, todayInShops());
  const branchName = contract.branch?.name ?? '';
  const branchPhone = contract.branch?.phone ?? '';
  const message =
    amountDue > 0
      ? `This phone is locked for an overdue installment of ${formatRupees(amountDue)}. Please pay at ${branchName || 'your branch'}${branchPhone ? ` or call ${branchPhone}` : ''} to unlock it.`
      : `Please contact ${branchName || 'your branch'}${branchPhone ? ` at ${branchPhone}` : ''}.`;

  return {
    locked: lockState === 'locked',
    customerName: contract.customerName,
    deviceLabel: contract.deviceLabel,
    amountDue,
    nextDueDate: nextUnpaid(contract.installments),
    branchName,
    branchPhone,
    message,
  };
}
