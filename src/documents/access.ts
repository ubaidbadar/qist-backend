import { Types, type PipelineStage, type InferSchemaType } from 'mongoose';
import { can, DEFAULT_DOCUMENT_POLICY, documentPolicySchema, type DocumentPolicy } from '@shop/shared';
import type { Document, DocumentRequest } from '../models/document';
import { Customer } from '../models/customer';
import { CustomerAccount } from '../models/customer_account';
import { Contract } from '../models/contract';
import type { AuthUser } from '../lib/auth_user';
import type { CustomerClaims } from '../lib/customer_session';
import { NotFoundError, ForbiddenError } from '../lib/errors';
import { scopeFilter, worksAt } from '../lib/scope';
import { parseId } from '../lib/ids';

export type Principal = { kind: 'staff'; auth: AuthUser } | { kind: 'customer'; claims: CustomerClaims };
export type DocumentRecord = InferSchemaType<typeof Document.schema> & { _id: Types.ObjectId };
type RequestRecord = InferSchemaType<typeof DocumentRequest.schema> & { _id: Types.ObjectId };
export interface DocumentContext {
  records?: DocumentRecord[];
  requests?: RequestRecord[];
  customerId: Types.ObjectId;
  orgId: Types.ObjectId;
  branchId: Types.ObjectId;
  contractId: Types.ObjectId | null;
  guarantors: { id?: string; fullName: string }[];
  policy: DocumentPolicy;
}
export const guarantorCategory = (category: string) => category.startsWith('guarantor_');
export const actorId = (principal: Principal) =>
  principal.kind === 'staff' ? principal.auth._id : new Types.ObjectId(principal.claims.sub);
export const mayReview = (principal: Principal) =>
  principal.kind === 'staff' && can(principal.auth.role, 'documents.review');
export const mayReadIdentity = (principal: Principal) =>
  principal.kind === 'customer' || can(principal.auth.role, 'documents.identity');

/** One scoped aggregate resolves the current relationship and active retailer, including customer session revocation. */
export async function documentContext(
  principal: Principal,
  target: { customerId?: string; contractId?: string },
  listing?: { cursor?: Types.ObjectId },
): Promise<DocumentContext> {
  const contract = target.contractId ? parseId(target.contractId, 'Contract') : null;
  const customer = target.customerId ? parseId(target.customerId, 'Customer') : null;
  if (!contract && !customer) throw new NotFoundError('Customer');
  const orgStage: PipelineStage[] = [
    {
      $lookup: {
        from: 'orgs',
        localField: 'orgId',
        foreignField: '_id',
        pipeline: [{ $match: { status: 'active' } }, { $project: { documentPolicy: 1 } }],
        as: 'org',
      },
    },
    { $unwind: '$org' },
    {
      $project: {
        _id: 1,
        orgId: 1,
        homeBranchId: 1,
        guarantors: 1,
        documentContract: 1,
        documentBranch: 1,
        policy: '$org.documentPolicy',
      },
    },
  ];
  const recordStages: PipelineStage[] = listing
    ? [
        {
          $lookup: {
            from: 'documents',
            let: { org: '$orgId', customer: '$_id', contract: { $ifNull: ['$documentContract', null] } },
            pipeline: [
              {
                $match: {
                  processing: { $ne: 'deleted' },
                  ...(listing.cursor ? { _id: { $lt: listing.cursor } } : {}),
                  $expr: {
                    $and: [
                      { $eq: ['$orgId', '$$org'] },
                      { $eq: ['$customerId', '$$customer'] },
                      {
                        $or: [
                          { $eq: ['$$contract', null] },
                          { $eq: ['$contractId', '$$contract'] },
                          {
                            $and: [
                              { $eq: ['$contractId', null] },
                              { $in: ['$category', ['customer_cnic_front', 'customer_cnic_back']] },
                            ],
                          },
                        ],
                      },
                      ...(principal.kind === 'customer'
                        ? [{ $eq: ['$actorId', actorId(principal)] }, { $eq: ['$uploadedBy', 'customer'] }]
                        : []),
                    ],
                  },
                },
              },
              { $sort: { _id: -1 } },
              { $limit: 21 },
              {
                $project: {
                  category: 1,
                  guarantorId: 1,
                  replacesId: 1,
                  requestId: 1,
                  processing: 1,
                  review: 1,
                  feedback: 1,
                  createdAt: 1,
                  updatedAt: 1,
                  uploadedBy: 1,
                  version: 1,
                  bytes: 1,
                  contentType: 1,
                  actorId: 1,
                  legalHold: 1,
                },
              },
            ],
            as: 'records',
          },
        },
        {
          $lookup: {
            from: 'document_requests',
            let: { org: '$orgId', contract: { $ifNull: ['$documentContract', null] } },
            pipeline: [
              {
                $match: {
                  closedAt: null,
                  $expr: { $and: [{ $eq: ['$orgId', '$$org'] }, { $eq: ['$contractId', '$$contract'] }] },
                },
              },
              { $sort: { _id: -1 } },
              { $limit: 20 },
              { $project: { category: 1, guarantorId: 1, message: 1 } },
            ],
            as: 'requests',
          },
        },
      ]
    : [];
  type Row = {
    records?: DocumentRecord[];
    requests?: RequestRecord[];
    _id: Types.ObjectId;
    orgId: Types.ObjectId;
    homeBranchId: Types.ObjectId;
    documentContract?: Types.ObjectId;
    documentBranch?: Types.ObjectId;
    guarantors: { id?: string; fullName: string }[];
    policy: unknown;
  };
  let rows: Row[];
  if (principal.kind === 'staff' && contract) {
    rows = await Contract.aggregate<Row>([
      {
        $match: {
          ...scopeFilter(principal.auth),
          _id: contract,
          ...(customer ? { customerId: customer } : {}),
        },
      },
      {
        $lookup: {
          from: 'customers',
          let: { customer: '$customerId', org: '$orgId' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$_id', '$$customer'] }, { $eq: ['$orgId', '$$org'] }] } } },
          ],
          as: 'owner',
        },
      },
      { $unwind: '$owner' },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: [
              '$owner',
              {
                documentContract: '$_id',
                documentBranch: '$branchId',
                guarantors: { $ifNull: ['$guarantorsSnapshot', '$owner.guarantors'] },
              },
            ],
          },
        },
      },
      ...orgStage,
      ...recordStages,
    ]);
  } else if (principal.kind === 'staff') {
    rows = await Customer.aggregate<Row>([
      { $match: { orgId: principal.auth.orgId, _id: customer } },
      ...orgStage,
      ...recordStages,
    ]);
  } else {
    const claims = principal.claims;
    rows = await CustomerAccount.aggregate<Row>([
      {
        $match: {
          _id: new Types.ObjectId(claims.sub),
          tokenVersion: claims.ver,
          sessions: { $elemMatch: { id: claims.sid, expiresAt: { $gt: new Date() } } },
        },
      },
      {
        $lookup: {
          from: 'customers',
          localField: 'phone',
          foreignField: 'phone',
          pipeline: customer ? [{ $match: { _id: customer } }] : [],
          as: 'owner',
        },
      },
      { $unwind: '$owner' },
      { $replaceRoot: { newRoot: '$owner' } },
      ...(contract
        ? ([
            {
              $lookup: {
                from: 'contracts',
                let: { customer: '$_id', org: '$orgId' },
                pipeline: [
                  {
                    $match: {
                      _id: contract,
                      $expr: { $and: [{ $eq: ['$customerId', '$$customer'] }, { $eq: ['$orgId', '$$org'] }] },
                    },
                  },
                ],
                as: 'agreement',
              },
            },
            { $unwind: '$agreement' },
            {
              $set: {
                documentContract: '$agreement._id',
                documentBranch: '$agreement.branchId',
                guarantors: { $ifNull: ['$agreement.guarantorsSnapshot', '$guarantors'] },
              },
            },
          ] as PipelineStage[])
        : []),
      ...orgStage,
      ...recordStages,
    ]);
  }
  const row = rows[0];
  if (!row) throw new NotFoundError('Documents');
  const branchId = row.documentBranch ?? row.homeBranchId;
  if (principal.kind === 'staff' && !worksAt(principal.auth, branchId)) throw new ForbiddenError();
  const parsed = documentPolicySchema.safeParse(row.policy);
  return {
    records: row.records,
    requests: row.requests,
    customerId: row._id,
    orgId: row.orgId,
    branchId,
    contractId: row.documentContract ?? null,
    guarantors: row.guarantors,
    policy: parsed.success ? parsed.data : { ...DEFAULT_DOCUMENT_POLICY },
  };
}
