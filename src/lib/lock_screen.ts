import { formatRupees, overdueAmount, todayInShops, type LockScreen } from '@shop/shared';
import type { Types } from 'mongoose';
import { Branch } from '../models/branch';
import { Contract } from '../models/contract';
import { Installment } from '../models/installment';

interface DeviceRef {
  orgId: Types.ObjectId;
  deviceId: Types.ObjectId;
  lockState: 'unlocked' | 'locked';
}

/** The earliest installment that still owes money, or null when the schedule is clear. */
const nextUnpaid = (installments: { dueDate: string; amount: number; lateFee: number; paidAmount: number }[]) =>
  installments
    .filter((i) => i.amount + i.lateFee > i.paidAmount)
    .map((i) => i.dueDate)
    .sort()[0] ?? null;

/**
 * Builds the live lock screen for a phone: what the customer owes, when the next payment is due, and which branch
 * to call. Read from the contract each time, never cached, so a payment made at the counter shows at once.
 */
export async function lockScreenFor({ orgId, deviceId, lockState }: DeviceRef): Promise<LockScreen> {
  const contract = await Contract.findOne({ orgId, deviceId, status: 'active' }).sort({ _id: -1 }).lean();
  if (!contract) {
    return { locked: lockState === 'locked', customerName: '', deviceLabel: '', amountDue: 0, nextDueDate: null, branchName: '', branchPhone: '', message: '' };
  }

  const [installments, branch] = await Promise.all([
    Installment.find({ orgId, contractId: contract._id }).lean(),
    Branch.findOne({ _id: contract.branchId, orgId }).select('name phone').lean(),
  ]);

  const amountDue = overdueAmount(installments, todayInShops());
  const branchName = branch?.name ?? '';
  const branchPhone = branch?.phone ?? '';
  const message =
    amountDue > 0
      ? `This phone is locked for an overdue installment of ${formatRupees(amountDue)}. Please pay at ${branchName || 'your branch'}${branchPhone ? ` or call ${branchPhone}` : ''} to unlock it.`
      : `Please contact ${branchName || 'your branch'}${branchPhone ? ` at ${branchPhone}` : ''}.`;

  return {
    locked: lockState === 'locked',
    customerName: contract.customerName,
    deviceLabel: contract.deviceLabel,
    amountDue,
    nextDueDate: nextUnpaid(installments),
    branchName,
    branchPhone,
    message,
  };
}
