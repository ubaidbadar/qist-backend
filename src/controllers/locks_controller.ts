import { commandListQuerySchema, commandRejectSchema, lockRequestSchema, overdueListQuerySchema, pauseLockSchema, todayInShops, type OverdueAccount } from '@shop/shared';
import type { Types } from 'mongoose';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import type { AuthUser } from '../lib/auth_user';
import { ConflictError, fieldDetails, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { cancelOpenLock, openCommandOf, queueCommand } from '../lib/locks';
import { wakeDevice } from '../lib/push';
import { paginate } from '../lib/paginate';
import { scopeFilter, worksAt } from '../lib/scope';
import { validate } from '../lib/validate';
import { Contract } from '../models/contract';
import { Device } from '../models/device';
import { DeviceCommand } from '../models/device_command';
import { overdueAccounts } from '../lib/overdue_accounts';

/** An active contract at a branch the user works at. */
async function contractToManage(auth: AuthUser, id: string | undefined) {
  const contract = await Contract.findOne({ _id: parseId(id, 'Contract'), orgId: auth.orgId }).lean();
  if (!contract) throw new NotFoundError('Contract');
  if (!worksAt(auth, contract.branchId)) throw new ForbiddenError("You don't work at that branch");
  if (contract.status !== 'active') throw new ConflictError('Only active contracts can be locked or paused');
  return contract;
}

const audit = (auth: AuthUser, contract: { _id: Types.ObjectId; branchId: Types.ObjectId }, action: string, summary: string) =>
  recordAudit(auth, { action, entity: 'contract', entityId: contract._id, branchId: contract.branchId, summary });

/** POST /contracts/:id/lock: a manager locks now, whatever the policy says. */
export const lock = authedController.createHandlers(validate('json', lockRequestSchema), async (c) => {
  const { auth } = c.var;
  const { reason } = c.req.valid('json');
  const contract = await contractToManage(auth, c.req.param('id'));
  const device = await Device.findOne({ _id: contract.deviceId, orgId: auth.orgId }).select('lockState').lean();
  if (device?.lockState === 'locked') throw new ConflictError('The phone is already locked');
  if (await openCommandOf(auth.orgId, contract.deviceId)) throw new ConflictError('A command for this phone is already waiting');

  const command = await withTransaction(async () => {
    const queued = await queueCommand({ contract, type: 'lock', status: 'pending', source: 'manual', reason, by: auth });
    await audit(auth, contract, 'lock.requested', `Asked to lock ${contract.customerName}'s ${contract.deviceLabel}: ${reason}`);
    return queued;
  });
  await wakeDevice(auth.orgId, contract.deviceId);
  return c.json({ data: command }, 201);
});

/** POST /contracts/:id/unlock: withdraws a lock still waiting, or asks a locked phone to unlock. */
export const unlock = authedController.createHandlers(validate('json', lockRequestSchema), async (c) => {
  const { auth } = c.var;
  const { reason } = c.req.valid('json');
  const contract = await contractToManage(auth, c.req.param('id'));
  const open = await openCommandOf(auth.orgId, contract.deviceId);
  const device = await Device.findOne({ _id: contract.deviceId, orgId: auth.orgId }).select('lockState').lean();
  if (open?.type !== 'lock' && device?.lockState !== 'locked') throw new ConflictError('The phone is not locked');
  if (open && open.type !== 'lock') throw new ConflictError('A command for this phone is already waiting');

  await withTransaction(async () => {
    if (open) await cancelOpenLock(auth.orgId, contract.deviceId, reason, auth);
    else await queueCommand({ contract, type: 'unlock', status: 'pending', source: 'manual', reason, by: auth });
    await audit(auth, contract, 'lock.unlock_requested', `${open ? 'Withdrew the lock' : 'Asked to unlock'} for ${contract.customerName}'s ${contract.deviceLabel}: ${reason}`);
  });
  if (!open) await wakeDevice(auth.orgId, contract.deviceId); // a queued unlock the phone should pick up now
  return c.json({ data: { ok: true } });
});

/** POST /contracts/:id/pause: a promise to pay. No automatic lock through `until`; a lock not yet sent is withdrawn. */
export const pause = authedController.createHandlers(validate('json', pauseLockSchema), async (c) => {
  const { auth } = c.var;
  const { until, reason } = c.req.valid('json');
  const contract = await contractToManage(auth, c.req.param('id'));
  if (until < todayInShops()) throw new ValidationError('Choose today or a later date', fieldDetails('until', 'In the past'));

  await withTransaction(async () => {
    await Contract.updateOne({ _id: contract._id, orgId: auth.orgId }, { $set: { autoLockPausedUntil: until, pauseReason: reason } });
    await cancelOpenLock(auth.orgId, contract.deviceId, `Paused until ${until}: ${reason}`, auth);
    await audit(auth, contract, 'lock.paused', `Paused automatic locking for ${contract.customerName} until ${until}: ${reason}`);
  });
  return c.json({ data: { ok: true } });
});

/** GET /commands?status&branchId&contractId: the Lock Center's queues and history. */
export const listCommands = authedController.createHandlers(validate('query', commandListQuerySchema), async (c) => {
  const { auth } = c.var;
  const { status, branchId, contractId, ...page } = c.req.valid('query');
  if (branchId && !worksAt(auth, branchId)) throw new ForbiddenError("You don't work at that branch");
  const filter = {
    ...(contractId ? { orgId: auth.orgId, contractId } : scopeFilter(auth)),
    ...(branchId ? { branchId } : {}),
    ...(status ? { status } : {}),
  };
  return c.json({ data: await paginate(DeviceCommand.find(filter).lean(), page) });
});

async function commandToDecide(auth: AuthUser, id: string | undefined) {
  const command = await DeviceCommand.findOne({ _id: parseId(id, 'Command'), orgId: auth.orgId }).lean();
  if (!command) throw new NotFoundError('Command');
  if (!worksAt(auth, command.branchId)) throw new ForbiddenError("You don't work at that branch");
  return command;
}

/** POST /commands/:id/approve: a proposed lock goes out. */
export const approve = authedController.createHandlers(async (c) => {
  const { auth } = c.var;
  const command = await commandToDecide(auth, c.req.param('id'));
  if (command.status !== 'proposed') throw new ConflictError('Only proposed locks can be approved');
  const updated = await withTransaction(async () => {
    const approved = await DeviceCommand.findOneAndUpdate(
      { _id: command._id, orgId: auth.orgId, status: 'proposed' },
      { $set: { status: 'pending', decidedBy: auth._id, decidedByName: auth.fullName } },
      { returnDocument: 'after' },
    ).lean();
    await recordAudit(auth, { action: 'lock.approved', entity: 'contract', entityId: command.contractId, branchId: command.branchId, summary: `Approved locking ${command.customerName}'s ${command.deviceLabel}` });
    return approved;
  });
  await wakeDevice(auth.orgId, command.deviceId);
  return c.json({ data: updated });
});

/** POST /commands/:id/cancel: rejects a proposal or withdraws a command not yet sent. */
export const cancelCommand = authedController.createHandlers(validate('json', commandRejectSchema), async (c) => {
  const { auth } = c.var;
  const { reason } = c.req.valid('json');
  const command = await commandToDecide(auth, c.req.param('id'));
  if (command.status !== 'proposed' && command.status !== 'pending') throw new ConflictError('This command already went out');
  const updated = await withTransaction(async () => {
    const cancelled = await DeviceCommand.findOneAndUpdate(
      { _id: command._id, orgId: auth.orgId, status: command.status },
      { $set: { status: 'cancelled', decidedBy: auth._id, decidedByName: auth.fullName, decisionReason: reason } },
      { returnDocument: 'after' },
    ).lean();
    await recordAudit(auth, { action: 'lock.cancelled', entity: 'contract', entityId: command.contractId, branchId: command.branchId, summary: `Cancelled the ${command.type} of ${command.customerName}'s ${command.deviceLabel}: ${reason}` });
    return cancelled;
  });
  return c.json({ data: updated });
});

/** GET /locks/overdue?branchId: contracts with installments past due, most days late first. */
export const overdue = authedController.createHandlers(validate('query', overdueListQuerySchema), async (c) => {
  const { auth } = c.var;
  const { branchId } = c.req.valid('query');
  if (branchId && !worksAt(auth, branchId)) throw new ForbiddenError("You don't work at that branch");
  const accounts: OverdueAccount[] = await overdueAccounts(auth, branchId);
  return c.json({ data: accounts });
});
