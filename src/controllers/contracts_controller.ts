import { buildSchedule, contractCancelSchema, contractCreateSchema, contractListQuerySchema, priceContract, todayInShops } from '@shop/shared';
import type { Types } from 'mongoose';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { createPayment } from '../lib/payments';
import type { AuthUser } from '../lib/auth_user';
import { ConflictError, fieldDetails, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { paginate } from '../lib/paginate';
import { scopeFilter, usableBranch, worksAt } from '../lib/scope';
import { validate } from '../lib/validate';
import { Contract } from '../models/contract';
import { Customer } from '../models/customer';
import { Device } from '../models/device';
import { Installment } from '../models/installment';
import { InstallmentPlan } from '../models/installment_plan';
import { Payment } from '../models/payment';

/**
 * Anyone in the retailer can read any contract, so a customer's history is visible at every branch.
 * Selling and cancelling happen only at branches the user works at.
 */

const withBranch = (orgId: Types.ObjectId) => ({ path: 'branch', select: 'name', match: { orgId } });

async function loadContract(auth: AuthUser, id: string | undefined) {
  const contract = await Contract.findOne({ _id: parseId(id, 'Contract'), orgId: auth.orgId })
    .populate<{ branch: { _id: Types.ObjectId; name: string } | null }>(withBranch(auth.orgId))
    .lean();
  if (!contract) throw new NotFoundError('Contract');
  const installments = await Installment.find({ orgId: auth.orgId, contractId: contract._id }).sort({ number: 1 }).lean();
  return { ...contract, installments };
}

/** GET /contracts?branchId&customerId&status: a customer's contracts across all branches, otherwise the user's branches. */
export const list = authedController.createHandlers(validate('query', contractListQuerySchema), async (c) => {
  const { auth } = c.var;
  const { branchId, customerId, status, ...page } = c.req.valid('query');
  if (branchId && !worksAt(auth, branchId)) throw new ForbiddenError("You don't work at that branch");

  const filter = {
    ...(customerId ? { orgId: auth.orgId, customerId } : scopeFilter(auth)),
    ...(branchId ? { branchId } : {}),
    ...(status ? { status } : {}),
  };
  const query = Contract.find(filter).populate(withBranch(auth.orgId)).lean();
  return c.json({ data: await paginate(query, page) });
});

/** GET /contracts/:id: the contract and its schedule. */
export const show = authedController.createHandlers(async (c) => {
  return c.json({ data: await loadContract(c.var.auth, c.req.param('id')) });
});

/** POST /contracts: sells a phone in stock on installments. Every amount is recalculated here from the terms. */
export const create = authedController.createHandlers(validate('json', contractCreateSchema), async (c) => {
  const { auth } = c.var;
  const input = c.req.valid('json');
  const branchId = await usableBranch(auth, input.branchId, 'branchId');
  if (input.firstDueDate < todayInShops()) {
    throw new ValidationError('The first installment cannot be due in the past', fieldDetails('firstDueDate', 'Choose today or later'));
  }

  const customer = await Customer.findOne({ _id: input.customerId, orgId: auth.orgId }).lean();
  if (!customer) throw new ValidationError('Choose a customer', fieldDetails('customerId', 'Unknown customer'));
  const device = await Device.findOne({ _id: input.deviceId, orgId: auth.orgId, branchId }).lean();
  if (!device) throw new ValidationError("Choose a phone from this branch's stock", fieldDetails('deviceId', 'Not in this branch'));

  if (input.planId) {
    const plan = await InstallmentPlan.findOne({ _id: input.planId, orgId: auth.orgId, active: true }).lean();
    if (!plan) throw new ValidationError('Choose an active plan', fieldDetails('planId', 'Unknown or inactive plan'));
    const minimum = Math.ceil((input.cashPrice * plan.minDownPaymentPercent) / 100);
    if (input.downPayment < minimum) {
      throw new ValidationError(`This plan needs a down payment of at least ${plan.minDownPaymentPercent}%`, fieldDetails('downPayment', 'Below the plan minimum'));
    }
  }

  const pricing = priceContract(input);
  const schedule = buildSchedule(pricing.totalPayable, input.count, input.frequency, input.firstDueDate);

  const contract = await withTransaction(async () => {
    // Claimed in one step: two sales of the same phone can't both succeed.
    const sold = await Device.findOneAndUpdate({ _id: device._id, orgId: auth.orgId, stockStatus: 'in_stock' }, { $set: { stockStatus: 'sold' } });
    if (!sold) throw new ConflictError('This phone is no longer in stock');

    const created = await Contract.create({
      ...input,
      ...pricing,
      branchId,
      orgId: auth.orgId,
      customerName: customer.fullName,
      customerCnic: customer.cnic,
      deviceLabel: `${device.brand} ${device.model}`,
      imeis: device.imeis,
      createdBy: auth._id,
    });
    await Installment.insertMany(schedule.map((item) => ({ ...item, orgId: auth.orgId, branchId, contractId: created._id })));
    if (input.downPayment > 0) {
      await createPayment({
        auth,
        branchId,
        contract: created,
        kind: 'down_payment',
        amount: input.downPayment,
        method: input.downPaymentMethod,
        reference: '',
        allocations: [],
        idempotencyKey: null,
      });
    }
    await recordAudit(auth, {
      action: 'contract.created',
      entity: 'contract',
      entityId: created._id,
      branchId,
      summary: `Sold ${created.deviceLabel} to ${created.customerName} in ${input.count} installments`,
    });
    return created;
  });
  return c.json({ data: await loadContract(auth, String(contract._id)) }, 201);
});

/** POST /contracts/:id/cancel: only before any payment; the phone goes back into stock. */
export const cancel = authedController.createHandlers(validate('json', contractCancelSchema), async (c) => {
  const { auth } = c.var;
  const existing = await loadContract(auth, c.req.param('id'));
  if (!worksAt(auth, existing.branchId)) throw new ForbiddenError("You don't work at that branch");
  if (existing.status !== 'active') throw new ConflictError('Only active contracts can be cancelled');
  if (existing.paidTotal > 0) throw new ConflictError("A contract with payments can't be cancelled");

  await withTransaction(async () => {
    await Contract.updateOne({ _id: existing._id, orgId: auth.orgId }, { $set: { status: 'cancelled', cancelReason: c.req.valid('json').reason } });
    await Device.updateOne({ _id: existing.deviceId, orgId: auth.orgId }, { $set: { stockStatus: 'in_stock' } });
    // The down payment goes back to the customer with the phone.
    await Payment.updateMany(
      { orgId: auth.orgId, contractId: existing._id, kind: 'down_payment', voidedAt: null },
      { $set: { voidedAt: new Date(), voidedBy: auth._id, voidReason: 'Contract cancelled' } },
    );
    await recordAudit(auth, {
      action: 'contract.cancelled',
      entity: 'contract',
      entityId: existing._id,
      branchId: existing.branchId,
      summary: `Cancelled the sale of ${existing.deviceLabel} to ${existing.customerName}`,
    });
  });
  return c.json({ data: await loadContract(auth, String(existing._id)) });
});
