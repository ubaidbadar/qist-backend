import type { CustomerAppContractChoice, CustomerAppInstallment, CustomerAppOverview, CustomerAppPayment, Page } from '@shop/shared';
import { todayInShops } from '@shop/shared';
import { Types, type PipelineStage } from 'mongoose';
import { CustomerAccount } from '../models/customer_account';
import type { CustomerClaims } from './customer_session';
import { NotFoundError, UnauthorizedError } from './errors';

const PAGE_SIZE = 20;
interface ContractRow extends Omit<CustomerAppContractChoice, 'id'> {
  _id: Types.ObjectId; orgId: Types.ObjectId; customerId: Types.ObjectId; deviceId: Types.ObjectId; branchId: Types.ObjectId;
  downPayment: number; totalPayable: number; paidTotal: number; lateFees: number; count: number; frequency: 'weekly' | 'biweekly' | 'monthly';
}
interface ReadRow {
  phone: string; name: string; contracts: ContractRow[]; selected?: ContractRow | null;
  installments?: CustomerAppInstallment[];
  payments: (Omit<CustomerAppPayment, 'id'> & { _id: Types.ObjectId })[];
  branch?: { phone: string; address: string } | null;
  device?: { lockState: 'locked' | 'unlocked' } | null;
}

const choice = (row: ContractRow): CustomerAppContractChoice => ({ id: String(row._id), deviceLabel: row.deviceLabel, retailer: row.retailer, status: row.status });
function pageOf(rows: ReadRow['payments']): Page<CustomerAppPayment> {
  const items = rows.slice(0, PAGE_SIZE).map(({ _id, ...payment }) => ({ id: String(_id), ...payment }));
  return { items, nextCursor: rows.length > PAGE_SIZE ? items.at(-1)!.id : null };
}

/** Every join matches BOTH the verified customer's id and retailer id; no staff or device secrets are projected. */
function readPipeline(claims: CustomerClaims, contractId?: string, cursor?: string, paymentsOnly = false): PipelineStage[] {
  const selected = contractId
    ? { $arrayElemAt: [{ $filter: { input: '$contracts', as: 'contract', cond: { $eq: ['$$contract._id', new Types.ObjectId(contractId)] } } }, 0] }
    : { $ifNull: [
      { $arrayElemAt: [{ $filter: { input: '$contracts', as: 'contract', cond: { $in: ['$$contract.status', ['active', 'defaulted']] } } }, 0] },
      { $arrayElemAt: ['$contracts', 0] },
    ] };
  const pipeline: PipelineStage[] = [
    { $match: { _id: new Types.ObjectId(claims.sub), tokenVersion: claims.ver, sessions: { $elemMatch: { id: claims.sid, expiresAt: { $gt: new Date() } } } } },
    { $lookup: { from: 'customers', let: { phone: '$phone' }, pipeline: [
      { $match: { $expr: { $eq: ['$phone', '$$phone'] } } },
      { $lookup: { from: 'orgs', localField: 'orgId', foreignField: '_id', pipeline: [{ $match: { status: 'active' } }, { $project: { name: 1 } }], as: 'org' } },
      { $unwind: '$org' },
      { $lookup: { from: 'contracts', let: { customer: '$_id', org: '$orgId' }, pipeline: [
        { $match: { ...(paymentsOnly && contractId ? { _id: new Types.ObjectId(contractId) } : {}), $expr: { $and: [{ $eq: ['$customerId', '$$customer'] }, { $eq: ['$orgId', '$$org'] }] } } },
        { $sort: { _id: -1 } },
        { $project: { orgId: 1, customerId: 1, deviceId: 1, branchId: 1, deviceLabel: 1, status: 1, downPayment: 1, totalPayable: 1, paidTotal: 1, lateFees: 1, count: 1, frequency: 1 } },
      ], as: 'contracts' } },
      { $project: { fullName: 1, contracts: { $map: { input: '$contracts', as: 'contract', in: { $mergeObjects: ['$$contract', { retailer: '$org.name' }] } } } } },
    ], as: 'customers' } },
    { $set: { contracts: { $reduce: { input: '$customers', initialValue: [], in: { $concatArrays: ['$$value', '$$this.contracts'] } } } } },
    { $set: { selected } },
    { $lookup: { from: 'payments', let: { contract: '$selected._id', org: '$selected.orgId', customer: '$selected.customerId' }, pipeline: [
      { $match: { voidedAt: null, ...(cursor ? { _id: { $lt: new Types.ObjectId(cursor) } } : {}), $expr: { $and: [{ $eq: ['$contractId', '$$contract'] }, { $eq: ['$orgId', '$$org'] }, { $eq: ['$customerId', '$$customer'] }] } } },
      { $sort: { _id: -1 } }, { $limit: PAGE_SIZE + 1 },
      { $project: { receiptNumber: 1, amount: 1, method: 1, receivedOn: 1, receivedByName: 1, kind: 1, reference: 1,
        allocations: { $map: { input: '$allocations', as: 'allocation', in: { number: '$$allocation.number', amount: '$$allocation.amount' } } },
      } },
    ], as: 'payments' } },
  ];
  if (!paymentsOnly) pipeline.push(
    { $lookup: { from: 'installments', let: { contract: '$selected._id', org: '$selected.orgId' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$contractId', '$$contract'] }, { $eq: ['$orgId', '$$org'] }] } } },
      { $sort: { number: 1 } }, { $project: { _id: 0, number: 1, dueDate: 1, amount: 1, lateFee: 1, paidAmount: 1, status: 1 } },
    ], as: 'installments' } },
    { $lookup: { from: 'devices', let: { device: '$selected.deviceId', org: '$selected.orgId' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$_id', '$$device'] }, { $eq: ['$orgId', '$$org'] }] } } },
      { $project: { _id: 0, lockState: 1 } },
    ], as: 'device' } },
    { $lookup: { from: 'branches', let: { branch: '$selected.branchId', org: '$selected.orgId' }, pipeline: [
      { $match: { active: true, $expr: { $and: [{ $eq: ['$_id', '$$branch'] }, { $eq: ['$orgId', '$$org'] }] } } },
      { $project: { _id: 0, phone: 1, address: 1 } },
    ], as: 'branch' } },
  );
  pipeline.push({ $project: {
    _id: 0, phone: 1, contracts: 1, selected: { $ifNull: ['$selected', null] }, payments: 1,
    name: { $let: {
      vars: { owner: { $arrayElemAt: [{ $filter: { input: '$customers', as: 'customer', cond: { $eq: ['$$customer._id', '$selected.customerId'] } } }, 0] } },
      in: { $ifNull: ['$$owner.fullName', { $ifNull: [{ $arrayElemAt: ['$customers.fullName', 0] }, '$phone'] }] },
    } },
    ...(paymentsOnly ? {} : { installments: 1, branch: { $arrayElemAt: ['$branch', 0] }, device: { $arrayElemAt: ['$device', 0] } }),
  } });
  return pipeline;
}

export async function loadCustomerOverview(claims: CustomerClaims, contractId?: string): Promise<CustomerAppOverview> {
  const [row] = await CustomerAccount.aggregate<ReadRow>(readPipeline(claims, contractId));
  if (!row) throw new UnauthorizedError();
  if (contractId && !row.selected) throw new NotFoundError('Plan');
  const selected = row.selected;
  return {
    profile: { name: row.name, phone: row.phone }, contracts: row.contracts.map(choice), today: todayInShops(), payments: pageOf(row.payments),
    contract: selected ? {
      ...choice(selected), downPayment: selected.downPayment, totalPayable: selected.totalPayable, paidTotal: selected.paidTotal,
      lateFees: selected.lateFees, count: selected.count, frequency: selected.frequency,
      retailerPhone: row.branch?.phone ?? '', retailerAddress: row.branch?.address ?? '',
      deviceLockState: row.device?.lockState ?? null, installments: row.installments ?? [],
    } : null,
  };
}

export async function loadCustomerPayments(claims: CustomerClaims, contractId: string, cursor?: string) {
  const [row] = await CustomerAccount.aggregate<ReadRow>(readPipeline(claims, contractId, cursor, true));
  if (!row) throw new UnauthorizedError();
  if (!row.selected) throw new NotFoundError('Plan');
  return pageOf(row.payments);
}
