import { addDays, todayInShops } from '@shop/shared';
import { Types } from 'mongoose';
import { Customer } from '../models/customer';
import { CustomerAccount } from '../models/customer_account';
import { CustomerNotification } from '../models/customer_notification';
import { CustomerPushToken } from '../models/customer_push_token';
import { Contract } from '../models/contract';
import { Installment } from '../models/installment';
import { Org } from '../models/org';
import { sendCustomerPush } from './push';
import { logger } from './logger';

type Kind = 'payment' | 'payment_voided' | 'phone_status' | 'due' | 'plan_changed';
const copy: Record<Kind, { title: string; body: string }> = {
  payment: { title: 'Payment recorded', body: 'Your retailer recorded a payment. Open Payments to view your receipt.' },
  payment_voided: { title: 'Payment corrected', body: 'Your retailer corrected a payment record. Open Payments for the current balance.' },
  phone_status: { title: 'Phone status updated', body: 'Your phone reported a status change. Open your plan for the latest information.' },
  plan_changed: { title: 'Plan updated', body: 'Your retailer updated your plans. Open Qist for the latest information.' },
  due: { title: 'Installment due today', body: 'An installment is due today. Open your plan for the amount and payment details.' },
};

/** Runs after the business transaction commits. An FCM outage never rolls it back. */
export async function notifyCustomerChange(orgId: Types.ObjectId, customerId: Types.ObjectId, contractId: Types.ObjectId, kind: Kind, eventKey: string, sendNow = true) {
  try {
    const [account] = await Customer.aggregate<{ accountId: Types.ObjectId }>([
      { $match: { _id: customerId, orgId } },
      { $lookup: { from: 'orgs', localField: 'orgId', foreignField: '_id', pipeline: [{ $match: { status: 'active' } }], as: 'org' } },
      { $match: { 'org.0': { $exists: true } } },
      { $lookup: { from: 'customer_accounts', localField: 'phone', foreignField: 'phone', pipeline: [{ $project: { _id: 1 } }], as: 'account' } },
      { $unwind: '$account' }, { $project: { _id: 0, accountId: '$account._id' } },
    ]);
    if (!account) return;
    await CustomerNotification.updateOne({ accountId: account.accountId, eventKey }, { $setOnInsert: {
      accountId: account.accountId, contractId, eventKey, kind, ...copy[kind], expiresAt: new Date(Date.now() + 90 * 86400_000),
    } }, { upsert: true });
    if (sendNow) void deliverCustomerNotifications().catch(() => logger.warn('Customer push queue deferred'));
  } catch { logger.warn('Could not queue customer notification'); }
}

/** Durable bounded retry queue; leases and event keys handle concurrent writers/repeated jobs. */
let delivering = false;
export async function deliverCustomerNotifications() {
  if (delivering) return;
  delivering = true;
  try {
  for (let i = 0; i < 20; i++) {
    const now = new Date();
    const event = await CustomerNotification.findOneAndUpdate({ deliveredAt: null, attempts: { $lt: 5 },
      nextAttemptAt: { $lte: now }, leaseUntil: { $lte: now }, expiresAt: { $gt: now } },
    { $set: { leaseUntil: new Date(now.getTime() + 60_000) }, $inc: { attempts: 1 } }, { sort: { _id: 1 }, returnDocument: 'after' }).lean();
    if (!event) return;
    try {
      const account = await CustomerAccount.findById(event.accountId).select('+sessions').lean();
      const sessions = account?.sessions.filter((s) => s.expiresAt > now).map((s) => s.id) ?? [];
      const tokens = await CustomerPushToken.find({ accountId: event.accountId, sessionId: { $in: sessions }, expiresAt: { $gt: now } }).select('+token').lean();
      const results = await Promise.all(tokens.map(async (token) => {
        const result = await sendCustomerPush(token.token, String(event._id));
        if (result === 'gone') await CustomerPushToken.deleteOne({ _id: token._id, accountId: event.accountId });
        return result;
      }));
      const retry = results.includes('retry');
      await CustomerNotification.updateOne({ _id: event._id }, { $set: { leaseUntil: new Date(0),
        ...(retry ? { nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** event.attempts) } : { deliveredAt: new Date() }),
      } });
    } catch { logger.warn('Customer notification retry deferred'); }
  }
  } finally { delivering = false; }
}

/** One due-day reminder per installment; no daily repeat alerts for the same overdue bill. */
export async function sendCustomerDueReminders(now = new Date()) {
  const today = todayInShops(now);
  for (const org of await Org.find({ status: 'active' }).select('_id').lean()) {
    const installments = Installment.find({ orgId: org._id, dueDate: today, status: { $in: ['pending', 'partial', 'overdue'] } }).select('_id contractId').lean().cursor();
    for await (const installment of installments) {
      const contract = await Contract.findOne({ _id: installment.contractId, orgId: org._id, status: { $in: ['active', 'defaulted'] } }).select('customerId').lean();
      if (contract) await notifyCustomerChange(org._id, contract.customerId, installment.contractId, 'due', `due:${installment._id}:${today}`, false);
    }
  }
  await deliverCustomerNotifications();
  return { today, next: addDays(today, 1) };
}

export async function notifyCustomerDeviceChange(orgId: Types.ObjectId, deviceId: Types.ObjectId, commandId: Types.ObjectId) {
  try {
    const contract = await Contract.findOne({ orgId, deviceId }).sort({ _id: -1 }).select('customerId').lean();
    if (contract) await notifyCustomerChange(orgId, contract.customerId, contract._id, 'phone_status', `command:${commandId}`);
  } catch { logger.warn('Could not queue phone status notification'); }
}
