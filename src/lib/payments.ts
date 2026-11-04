import { allocatePayment, installmentStatus, todayInShops, type Allocation, type PaymentMethod } from '@shop/shared';
import type { Types } from 'mongoose';
import { Counter } from '../models/counter';
import { Installment } from '../models/installment';
import { Payment } from '../models/payment';
import type { AuthUser } from './auth_user';
import { fieldDetails, ValidationError } from './errors';

/** The next receipt number of a branch. Call inside the payment's transaction, so a failed payment uses no number. */
export async function nextReceiptNumber(orgId: Types.ObjectId, branchId: Types.ObjectId) {
  const counter = await Counter.findOneAndUpdate(
    { orgId, branchId, name: 'receipt' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return counter?.seq ?? 1;
}

/**
 * Adds (`sign` 1) or takes back (`sign` -1, a void) money on installments, and recalculates each one's status.
 * Reads the schedule inside the caller's transaction, so concurrent payments see each other's changes.
 */
type InstallmentRows = Awaited<ReturnType<typeof loadInstallments>>;

const loadInstallments = (orgId: Types.ObjectId, contractId: Types.ObjectId) =>
  Installment.find({ orgId, contractId }).sort({ number: 1 }).lean();

/** One schedule read and one bulk write, instead of rereading and updating each installment individually. */
export async function applyToInstallments(
  orgId: Types.ObjectId,
  contractId: Types.ObjectId,
  allocations: Allocation[],
  sign: 1 | -1,
  loaded?: InstallmentRows,
) {
  if (!allocations.length) return;
  const installments = loaded ?? (await loadInstallments(orgId, contractId));
  const byNumber = new Map(installments.map((item) => [item.number, item]));
  const today = todayInShops();
  const operations = allocations.flatMap(({ number, amount }) => {
    const installment = byNumber.get(number);
    if (!installment) return [];
    const paidAmount = installment.paidAmount + sign * amount;
    return [{
      updateOne: {
        filter: { _id: installment._id, orgId, contractId },
        update: { $set: { paidAmount, status: installmentStatus({ ...installment, paidAmount }, today) } },
      },
    }];
  });
  if (operations.length) await Installment.bulkWrite(operations);
}

/** Where a new payment goes, oldest installment first. A payment above the balance is a form error. */
export async function planAllocations(orgId: Types.ObjectId, contractId: Types.ObjectId, amount: number) {
  const installments = await loadInstallments(orgId, contractId);
  try {
    const allocations = allocatePayment(installments, amount);
    const byNumber = new Map(installments.map((item) => [item.number, item]));
    return {
      installments,
      allocations: allocations.flatMap((allocation) => {
        const installment = byNumber.get(allocation.number);
        return installment ? [{ ...allocation, installmentId: installment._id }] : [];
      }),
    };
  } catch (err) {
    if (err instanceof RangeError) throw new ValidationError(err.message, fieldDetails('amount', err.message));
    throw err;
  }
}

interface NewPayment {
  auth: AuthUser;
  branchId: Types.ObjectId;
  contract: { _id: Types.ObjectId; customerId: Types.ObjectId; customerName: string; deviceLabel: string };
  kind: 'down_payment' | 'installment';
  amount: number;
  method: PaymentMethod;
  reference: string;
  allocations: { installmentId: Types.ObjectId; number: number; amount: number }[];
  idempotencyKey: string | null;
}

/** Saves a payment with the branch's next receipt number. Call inside a transaction. */
export async function createPayment({ auth, branchId, contract, ...payment }: NewPayment) {
  return Payment.create({
    ...payment,
    orgId: auth.orgId,
    branchId,
    contractId: contract._id,
    customerId: contract.customerId,
    customerName: contract.customerName,
    deviceLabel: contract.deviceLabel,
    receiptNumber: await nextReceiptNumber(auth.orgId, branchId),
    receivedBy: auth._id,
    receivedByName: auth.fullName,
    receivedOn: todayInShops(),
  });
}
