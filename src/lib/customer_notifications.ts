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

function notificationWrite(accountId: Types.ObjectId, contractId: Types.ObjectId, kind: Kind, eventKey: string, now = new Date()) {
  return { updateOne: { filter: { accountId, eventKey }, update: { $setOnInsert: {
    accountId, contractId, eventKey, kind, ...copy[kind], expiresAt: new Date(now.getTime() + 90 * 86400_000),
  } }, upsert: true } };
}

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
    const { filter, update, upsert } = notificationWrite(account.accountId, contractId, kind, eventKey).updateOne;
    await CustomerNotification.updateOne(filter, update, { upsert });
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
        const tokens = await CustomerPushToken.find({ _id: { $nin: event.deliveredTokens ?? [] }, accountId: event.accountId, sessionId: { $in: sessions }, expiresAt: { $gt: now } }).select('+token').lean();
        const results = await Promise.all(tokens.map(async (token) => {
          const delivery = await sendCustomerPush(token.token, String(event._id));
          if (delivery.result === 'gone') await CustomerPushToken.deleteOne({ _id: token._id, accountId: event.accountId });
          return { id: token._id, ...delivery };
        }));
        const retry = results.some(({ result }) => result === 'retry');
        const retryAfter = results.reduce((wait, delivery) => Math.max(wait, delivery.retryAfterSeconds * 1000), 0);
        const delivered = results.filter(({ result }) => result === 'sent').map(({ id }) => id);
        await CustomerNotification.updateOne({ _id: event._id }, { $set: { leaseUntil: new Date(0),
          ...(retry ? { nextAttemptAt: new Date(Date.now() + Math.max(60_000 * 2 ** event.attempts, retryAfter) + Math.floor(Math.random() * 10_000)) } : { deliveredAt: new Date() }),
        }, ...(delivered.length ? { $addToSet: { deliveredTokens: { $each: delivered } } } : {}) });
      } catch { logger.warn('Customer notification retry deferred'); }
    }
  } finally { delivering = false; }
}

/** One due-day reminder per installment; no daily repeat alerts for the same overdue bill. */
export async function sendCustomerDueReminders(now = new Date()) {
  const today = todayInShops(now);
  for (const org of await Org.find({ status: 'active' }).select('_id').lean()) {
    const rows = Installment.aggregate<{ _id: Types.ObjectId; contractId: Types.ObjectId; accountId: Types.ObjectId }>([
      { $match: { orgId: org._id, dueDate: today, status: { $in: ['pending', 'partial', 'overdue'] } } },
      { $lookup: { from: 'contracts', localField: 'contractId', foreignField: '_id', pipeline: [
        { $match: { orgId: org._id, status: { $in: ['active', 'defaulted'] } } }, { $project: { customerId: 1 } },
      ], as: 'contract' } },
      { $unwind: '$contract' },
      { $lookup: { from: 'customers', localField: 'contract.customerId', foreignField: '_id', pipeline: [
        { $match: { orgId: org._id } }, { $project: { phone: 1 } },
      ], as: 'customer' } },
      { $unwind: '$customer' },
      { $lookup: { from: 'customer_accounts', localField: 'customer.phone', foreignField: 'phone', pipeline: [{ $project: { _id: 1 } }], as: 'account' } },
      { $unwind: '$account' }, { $project: { contractId: 1, accountId: '$account._id' } },
    ]).cursor({ batchSize: 100 });
    const batch: ReturnType<typeof notificationWrite>[] = [];
    for await (const installment of rows) {
      batch.push(notificationWrite(installment.accountId, installment.contractId, 'due', `due:${installment._id}:${today}`, now));
      if (batch.length === 100) { await CustomerNotification.bulkWrite(batch.splice(0), { ordered: false }); }
    }
    if (batch.length) await CustomerNotification.bulkWrite(batch, { ordered: false });
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
