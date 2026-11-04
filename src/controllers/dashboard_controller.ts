import { dashboardQuerySchema, type DashboardSnapshot } from '@shop/shared';
import { Types } from 'mongoose';
import { ForbiddenError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { validate } from '../lib/validate';
import { worksAt, scopeFilter } from '../lib/scope';
import { mapOverdueRows, overdueAccountPipeline, type OverdueRow } from '../lib/overdue_accounts';
import { Org } from '../models/org';

interface RecentPayment {
  _id: Types.ObjectId;
  customerName: string;
  deviceLabel: string;
  receiptNumber: number;
  amount: number;
  voidedAt: Date | null;
}

interface RecentContract {
  _id: Types.ObjectId;
  customerName: string;
  deviceLabel: string;
  status: DashboardSnapshot['contracts'][number]['status'];
  createdAt: Date;
}

interface PaymentFacet {
  recent: RecentPayment[];
  totals: { total: number; count: number }[];
}

interface DashboardAggregation {
  paymentData: PaymentFacet[];
  recentContracts: RecentContract[];
  overdueRows: OverdueRow[];
}

/**
 * One authenticated HTTP request and one MongoDB aggregate command.
 * Each $lookup has a tenant/branch filter, with indexed match stages and
 * bounded recent lists; payment sums exclude voids while recent activity includes them.
 */
export const show = authedController.createHandlers(validate('query', dashboardQuerySchema), async (c) => {
  const { auth } = c.var;
  const { branchId, date } = c.req.valid('query');
  if (branchId && !worksAt(auth, branchId)) throw new ForbiddenError("You don't work at that branch");

  const scope = {
    ...scopeFilter(auth),
    ...(branchId ? { branchId: new Types.ObjectId(branchId) } : {}),
  };

  const [result] = await Org.aggregate<DashboardAggregation>([
    { $match: { _id: auth.orgId } },
    { $limit: 1 },
    {
      $lookup: {
        from: 'payments',
        pipeline: [
          { $match: { ...scope, receivedOn: date } },
          {
            $facet: {
              recent: [
                { $sort: { _id: -1 } },
                { $limit: 5 },
                { $project: { customerName: 1, deviceLabel: 1, receiptNumber: 1, amount: 1, voidedAt: 1 } },
              ],
              totals: [
                { $match: { voidedAt: null } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
              ],
            },
          },
        ],
        as: 'paymentData',
      },
    },
    {
      $lookup: {
        from: 'contracts',
        pipeline: [
          { $match: scope },
          { $sort: { _id: -1 } },
          { $limit: 5 },
          { $project: { customerName: 1, deviceLabel: 1, status: 1, createdAt: 1 } },
        ],
        as: 'recentContracts',
      },
    },
    {
      $lookup: {
        from: 'installments',
        pipeline: overdueAccountPipeline(auth, date, branchId),
        as: 'overdueRows',
      },
    },
    { $project: { paymentData: 1, recentContracts: 1, overdueRows: 1 } },
  ]);

  const payments = result?.paymentData[0];
  const data: DashboardSnapshot = {
    date,
    collections: { total: payments?.totals[0]?.total ?? 0, count: payments?.totals[0]?.count ?? 0 },
    overdue: mapOverdueRows(result?.overdueRows ?? [], date),
    payments: payments?.recent.map((payment) => ({
      _id: String(payment._id),
      customerName: payment.customerName,
      deviceLabel: payment.deviceLabel,
      receiptNumber: payment.receiptNumber,
      amount: payment.amount,
      voidedAt: payment.voidedAt?.toISOString() ?? null,
    })) ?? [],
    contracts: result?.recentContracts.map((contract) => ({
      _id: String(contract._id),
      customerName: contract.customerName,
      deviceLabel: contract.deviceLabel,
      status: contract.status,
      createdAt: contract.createdAt.toISOString(),
    })) ?? [],
  };

  return c.json({ data });
});
