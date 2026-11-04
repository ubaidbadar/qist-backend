import {
  daysOverdue,
  overdueAmount,
  todayInShops,
  type CommandStatus,
  type CommandType,
  type DeviceLockState,
  type DueInstallment,
  type OverdueAccount,
} from '@shop/shared';
import { Types } from 'mongoose';
import { Installment } from '../models/installment';
import { OPEN_STATUSES } from '../models/device_command';
import type { AuthUser } from './auth_user';
import { scopeFilter } from './scope';

const MAX_ACCOUNTS = 300;

interface OverdueRow {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  customerId: Types.ObjectId;
  customerName: string;
  deviceId: Types.ObjectId;
  deviceLabel: string;
  autoLockPausedUntil?: string | null;
  schedule: DueInstallment[];
  openCommands: { _id: Types.ObjectId; type: CommandType; status: CommandStatus }[];
  devices: { lockState: DeviceLockState }[];
}

/**
 * Read overdue accounts in one server-side aggregation rather than fetching four whole collections
 * and repeatedly scanning each array in JavaScript. Only 300 active contracts may reach the
 * schedule/command/device lookups. Every lookup is explicitly tenant scoped.
 */
export async function overdueAccounts(auth: AuthUser, branchId?: string): Promise<OverdueAccount[]> {
  const today = todayInShops();
  const scope = { ...scopeFilter(auth), ...(branchId ? { branchId: new Types.ObjectId(branchId) } : {}) };

  const rows = await Installment.aggregate<OverdueRow>([
    { $match: { ...scope, status: { $in: ['pending', 'partial', 'overdue'] }, dueDate: { $lt: today } } },
    { $group: { _id: '$contractId' } },
    {
      $lookup: {
        from: 'contracts',
        localField: '_id',
        foreignField: '_id',
        pipeline: [
          { $match: { orgId: auth.orgId, status: 'active' } },
          { $project: { branchId: 1, customerId: 1, customerName: 1, deviceId: 1, deviceLabel: 1, autoLockPausedUntil: 1 } },
        ],
        as: 'contracts',
      },
    },
    { $unwind: '$contracts' },
    { $replaceRoot: { newRoot: '$contracts' } },
    { $limit: MAX_ACCOUNTS },
    {
      $lookup: {
        from: 'installments',
        let: { contractId: '$_id' },
        pipeline: [
          { $match: { orgId: auth.orgId, $expr: { $eq: ['$contractId', '$$contractId'] } } },
          { $sort: { number: 1 } },
          { $project: { dueDate: 1, amount: 1, paidAmount: 1, lateFee: 1 } },
        ],
        as: 'schedule',
      },
    },
    {
      $lookup: {
        from: 'deviceCommands',
        let: { contractId: '$_id' },
        pipeline: [
          { $match: { orgId: auth.orgId, status: { $in: [...OPEN_STATUSES] }, $expr: { $eq: ['$contractId', '$$contractId'] } } },
          { $sort: { _id: -1 } },
          { $limit: 1 },
          { $project: { type: 1, status: 1 } },
        ],
        as: 'openCommands',
      },
    },
    {
      $lookup: {
        from: 'devices',
        let: { deviceId: '$deviceId' },
        pipeline: [
          { $match: { orgId: auth.orgId, $expr: { $eq: ['$_id', '$$deviceId'] } } },
          { $project: { lockState: 1 } },
        ],
        as: 'devices',
      },
    },
  ]);

  return rows
    .map((row) => {
      const late = row.schedule
        .filter((item) => item.dueDate < today && item.amount + item.lateFee > item.paidAmount)
        .map((item) => item.dueDate)
        .sort();
      const command = row.openCommands[0];
      return {
        contractId: String(row._id),
        branchId: String(row.branchId),
        customerId: String(row.customerId),
        customerName: row.customerName,
        deviceId: String(row.deviceId),
        deviceLabel: row.deviceLabel,
        lockState: row.devices[0]?.lockState ?? 'unlocked',
        daysOverdue: daysOverdue(row.schedule, today),
        overdueAmount: overdueAmount(row.schedule, today),
        oldestDueDate: late[0] ?? '',
        autoLockPausedUntil: row.autoLockPausedUntil ?? null,
        openCommand: command ? { _id: String(command._id), type: command.type, status: command.status } : null,
      } satisfies OverdueAccount;
    })
    .filter((account) => account.overdueAmount > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}
