import { daysOverdue, overdueAmount, todayInShops, type OverdueAccount } from '@shop/shared';
import { Types } from 'mongoose';
import { Contract } from '../models/contract';
import { Device } from '../models/device';
import { DeviceCommand, OPEN_STATUSES } from '../models/device_command';
import { Installment } from '../models/installment';
import type { AuthUser } from './auth_user';
import { scopeFilter } from './scope';

const MAX_ACCOUNTS = 300;

/** Active contracts at the user's branches with something past due, most days late first. */
export async function overdueAccounts(auth: AuthUser, branchId?: string): Promise<OverdueAccount[]> {
  const today = todayInShops();
  const scope = { ...scopeFilter(auth), ...(branchId ? { branchId: new Types.ObjectId(branchId) } : {}) };
  const contractIds = await Installment.distinct('contractId', { ...scope, status: { $in: ['pending', 'partial', 'overdue'] }, dueDate: { $lt: today } });

  const [contracts, installments, commands] = await Promise.all([
    Contract.find({ orgId: auth.orgId, _id: { $in: contractIds }, status: 'active' }).limit(MAX_ACCOUNTS).lean(),
    Installment.find({ orgId: auth.orgId, contractId: { $in: contractIds } }).lean(),
    DeviceCommand.find({ orgId: auth.orgId, contractId: { $in: contractIds }, status: { $in: [...OPEN_STATUSES] } }).lean(),
  ]);
  const devices = await Device.find({ orgId: auth.orgId, _id: { $in: contracts.map((c) => c.deviceId) } }).select('lockState').lean();

  return contracts
    .map((contract) => {
      const schedule = installments.filter((i) => i.contractId.equals(contract._id));
      const command = commands.find((cmd) => cmd.contractId.equals(contract._id));
      const late = schedule.filter((i) => i.dueDate < today && i.amount + i.lateFee > i.paidAmount).map((i) => i.dueDate).sort();
      return {
        contractId: String(contract._id),
        branchId: String(contract.branchId),
        customerId: String(contract.customerId),
        customerName: contract.customerName,
        deviceId: String(contract.deviceId),
        deviceLabel: contract.deviceLabel,
        lockState: devices.find((d) => d._id.equals(contract.deviceId))?.lockState ?? 'unlocked',
        daysOverdue: daysOverdue(schedule, today),
        overdueAmount: overdueAmount(schedule, today),
        oldestDueDate: late[0] ?? '',
        autoLockPausedUntil: contract.autoLockPausedUntil ?? null,
        openCommand: command ? { _id: String(command._id), type: command.type, status: command.status } : null,
      };
    })
    .filter((account) => account.overdueAmount > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}
