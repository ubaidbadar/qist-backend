import { collectionsQuerySchema, formatRupees, IDEMPOTENCY_HEADER, paymentCreateSchema, paymentListQuerySchema, paymentVoidSchema } from '@shop/shared';
import { Types } from 'mongoose';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import type { AuthUser } from '../lib/auth_user';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { paginate } from '../lib/paginate';
import { afterPayment } from '../lib/locks';
import { applyToInstallments, createPayment, planAllocations } from '../lib/payments';
import { scopeFilter, usableBranch, worksAt } from '../lib/scope';
import { validate } from '../lib/validate';
import { Contract } from '../models/contract';
import { Device } from '../models/device';
import { Payment } from '../models/payment';

const MAX_KEY_LENGTH = 100;
const withBranch = (orgId: Types.ObjectId) => ({ path: 'branch', select: 'name', match: { orgId } });
const findPayment = (auth: AuthUser, id: Types.ObjectId) => Payment.findOne({ _id: id, orgId: auth.orgId }).populate(withBranch(auth.orgId)).lean();

/** POST /contracts/:id/payments: needs an Idempotency-Key header; repeating the request returns the same payment. */
export const record = authedController.createHandlers(validate('json', paymentCreateSchema), async (c) => {
  const { auth } = c.var;
  const input = c.req.valid('json');
  const key = c.req.header(IDEMPOTENCY_HEADER);
  if (!key || key.length > MAX_KEY_LENGTH) throw new ValidationError(`Send a unique ${IDEMPOTENCY_HEADER} header with each new payment`);
  const contractId = parseId(c.req.param('id'), 'Contract');

  const replay = async () => {
    const earlier = await Payment.findOne({ orgId: auth.orgId, idempotencyKey: key }).lean();
    if (!earlier) return null;
    if (!earlier.contractId.equals(contractId) || earlier.amount !== input.amount) {
      throw new ConflictError('This request key was already used for a different payment');
    }
    return c.json({ data: await findPayment(auth, earlier._id) });
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const { branchId: requestedBranch, ...details } = input;
  const branchId = await usableBranch(auth, requestedBranch, 'branchId');
  try {
    const payment = await withTransaction(async () => {
      const contract = await Contract.findOne({ _id: contractId, orgId: auth.orgId }).lean();
      if (!contract) throw new NotFoundError('Contract');
      if (contract.status !== 'active') throw new ConflictError('Only active contracts take payments');

      const allocations = await planAllocations(auth.orgId, contract._id, input.amount);
      await applyToInstallments(auth.orgId, contract._id, allocations, 1);
      const paidOff = contract.paidTotal + input.amount === contract.totalPayable + contract.lateFees;
      await Contract.updateOne({ _id: contract._id, orgId: auth.orgId }, { $inc: { paidTotal: input.amount }, ...(paidOff ? { $set: { status: 'completed' } } : {}) });
      if (paidOff) await Device.updateOne({ _id: contract.deviceId, orgId: auth.orgId }, { $set: { stockStatus: 'released' } });
      await afterPayment(contract, paidOff);

      const created = await createPayment({ auth, branchId, contract, kind: 'installment', ...details, allocations, idempotencyKey: key });
      await recordAudit(auth, {
        action: 'payment.recorded',
        entity: 'payment',
        entityId: created._id,
        branchId,
        summary: `Received ${formatRupees(input.amount)} from ${contract.customerName} (receipt ${created.receiptNumber})${paidOff ? '; contract paid off' : ''}`,
      });
      return created;
    });
    return c.json({ data: await findPayment(auth, payment._id) }, 201);
  } catch (err) {
    // Two identical requests at once: the unique key let one through; answer the other with the same payment.
    if (err instanceof Error && 'code' in err && err.code === 11000) {
      const retried = await replay();
      if (retried) return retried;
    }
    throw err;
  }
});

/** GET /contracts/:id/payments: the contract's ledger, newest first, voided payments included. */
export const ledger = authedController.createHandlers(async (c) => {
  const { auth } = c.var;
  const contractId = parseId(c.req.param('id'), 'Contract');
  const payments = await Payment.find({ orgId: auth.orgId, contractId }).sort({ _id: -1 }).populate(withBranch(auth.orgId)).lean();
  return c.json({ data: payments });
});

/** GET /payments/:id: one payment, for its receipt. */
export const show = authedController.createHandlers(async (c) => {
  const payment = await findPayment(c.var.auth, parseId(c.req.param('id'), 'Payment'));
  if (!payment) throw new NotFoundError('Payment');
  return c.json({ data: payment });
});

/** GET /payments?branchId&date: payments received at the user's branches, newest first. */
export const list = authedController.createHandlers(validate('query', paymentListQuerySchema), async (c) => {
  const { auth } = c.var;
  const { branchId, date, ...page } = c.req.valid('query');
  if (branchId && !worksAt(auth, branchId)) throw new ForbiddenError("You don't work at that branch");
  const filter = { ...scopeFilter(auth), ...(branchId ? { branchId } : {}), ...(date ? { receivedOn: date } : {}) };
  return c.json({ data: await paginate(Payment.find(filter).populate(withBranch(auth.orgId)).lean(), page) });
});

/** GET /payments/collections?branchId&date: one day's takings by method and by person, voids left out. */
export const collections = authedController.createHandlers(validate('query', collectionsQuerySchema), async (c) => {
  const { auth } = c.var;
  const { branchId, date } = c.req.valid('query');
  if (branchId && !worksAt(auth, branchId)) throw new ForbiddenError("You don't work at that branch");
  const scope = scopeFilter(auth);
  const match = { ...scope, receivedOn: date, voidedAt: null, ...(branchId ? { branchId: new Types.ObjectId(branchId) } : {}) };

  const [result] = await Payment.aggregate<{ total: { total: number; count: number }[]; byMethod: { _id: string; total: number; count: number }[]; byStaff: { _id: Types.ObjectId; name: string; total: number; count: number }[] }>([
    { $match: match },
    {
      $facet: {
        total: [{ $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }],
        byMethod: [{ $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { total: -1 } }],
        byStaff: [{ $group: { _id: '$receivedBy', name: { $first: '$receivedByName' }, total: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { total: -1 } }],
      },
    },
  ]);
  return c.json({
    data: {
      date,
      total: result?.total[0]?.total ?? 0,
      count: result?.total[0]?.count ?? 0,
      byMethod: result?.byMethod.map(({ _id, ...rest }) => ({ method: _id, ...rest })) ?? [],
      byStaff: result?.byStaff.map(({ _id, ...rest }) => ({ userId: String(_id), ...rest })) ?? [],
    },
  });
});

/** POST /payments/:id/void: reverses a payment's allocations; the payment itself is kept, marked void. */
export const voidPayment = authedController.createHandlers(validate('json', paymentVoidSchema), async (c) => {
  const { auth } = c.var;
  const paymentId = parseId(c.req.param('id'), 'Payment');
  const { reason } = c.req.valid('json');

  await withTransaction(async () => {
    const payment = await Payment.findOne({ _id: paymentId, orgId: auth.orgId }).lean();
    if (!payment) throw new NotFoundError('Payment');
    if (!worksAt(auth, payment.branchId)) throw new ForbiddenError("You don't work at the branch that received it");
    if (payment.voidedAt) throw new ConflictError('This payment is already void');
    if (payment.kind === 'down_payment') throw new ConflictError('A down payment is undone by cancelling the contract');

    const contract = await Contract.findOne({ _id: payment.contractId, orgId: auth.orgId }).lean();
    if (!contract) throw new NotFoundError('Contract');
    await applyToInstallments(auth.orgId, contract._id, payment.allocations, -1);
    await Contract.updateOne({ _id: contract._id, orgId: auth.orgId }, { $inc: { paidTotal: -payment.amount }, $set: { status: 'active' } });
    if (contract.status === 'completed') await Device.updateOne({ _id: contract.deviceId, orgId: auth.orgId }, { $set: { stockStatus: 'sold' } });
    await Payment.updateOne({ _id: payment._id, orgId: auth.orgId }, { $set: { voidedAt: new Date(), voidedBy: auth._id, voidReason: reason } });
    await recordAudit(auth, {
      action: 'payment.voided',
      entity: 'payment',
      entityId: payment._id,
      branchId: payment.branchId,
      summary: `Voided receipt ${payment.receiptNumber} (${formatRupees(payment.amount)} from ${payment.customerName}): ${reason}`,
    });
  });
  return c.json({ data: await findPayment(auth, paymentId) });
});
