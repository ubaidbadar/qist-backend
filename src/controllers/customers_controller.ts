import { customerCreateSchema, customerListQuerySchema, customerUpdateSchema, normalizeMobile, pageQuerySchema } from '@shop/shared';
import type { Types } from 'mongoose';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import type { AuthUser } from '../lib/auth_user';
import { ConflictError, NotFoundError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { paginate } from '../lib/paginate';
import { usableBranch } from '../lib/scope';
import { validate } from '../lib/validate';
import { Contract } from '../models/contract';
import { Customer } from '../models/customer';

/** Customers belong to the organization: everyone in it can find any customer, whichever branch they came from. */

const withHomeBranch = (orgId: Types.ObjectId) => ({ path: 'homeBranch', select: 'name', match: { orgId } });

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Digits search the start of the CNIC or mobile number; anything else searches inside the name. */
function searchFilter(q: string | undefined) {
  if (!q) return {};
  if (/^[\d\s+-]+$/.test(q)) {
    const digits = q.replace(/\D/g, '');
    return { $or: [{ cnic: { $regex: `^${digits}` } }, { phone: { $regex: `^${normalizeMobile(q)}` } }] };
  }
  return { fullName: { $regex: escapeRegex(q), $options: 'i' } };
}

async function assertCnicIsFree(auth: AuthUser, cnic: string, exceptId?: Types.ObjectId) {
  const existing = await Customer.findOne({ orgId: auth.orgId, cnic, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .select('fullName')
    .lean();
  if (existing) {
    throw new ConflictError(`This CNIC already belongs to ${existing.fullName}`, {
      fields: [{ path: 'cnic', message: 'Already registered' }],
      customerId: String(existing._id),
    });
  }
}

async function findCustomer(auth: AuthUser, id: string | undefined) {
  const customer = await Customer.findOne({ _id: parseId(id, 'Customer'), orgId: auth.orgId })
    .populate<{ homeBranch: { _id: Types.ObjectId; name: string } | null }>(withHomeBranch(auth.orgId))
    .lean();
  if (!customer) throw new NotFoundError('Customer');
  return customer;
}

/** GET /customers?q&limit&cursor */
export const list = authedController.createHandlers(validate('query', customerListQuerySchema), async (c) => {
  const { orgId } = c.var.auth;
  const { q, ...page } = c.req.valid('query');
  const query = Customer.find({ orgId, ...searchFilter(q) }).populate(withHomeBranch(orgId)).lean();
  return c.json({ data: await paginate(query, page) });
});

/** GET /customers/:id */
export const show = authedController.createHandlers(async (c) => {
  return c.json({ data: await findCustomer(c.var.auth, c.req.param('id')) });
});

/** POST /customers */
export const create = authedController.createHandlers(validate('json', customerCreateSchema), async (c) => {
  const { auth } = c.var;
  const input = c.req.valid('json');
  const homeBranchId = await usableBranch(auth, input.homeBranchId, 'homeBranchId');
  await assertCnicIsFree(auth, input.cnic);

  const customer = await withTransaction(async () => {
    const created = await Customer.create({ ...input, homeBranchId, orgId: auth.orgId, createdBy: auth._id });
    await recordAudit(auth, { action: 'customer.created', entity: 'customer', entityId: created._id, branchId: homeBranchId, summary: `Added customer ${created.fullName}` });
    return created;
  });
  return c.json({ data: await findCustomer(auth, String(customer._id)) }, 201);
});

/** PATCH /customers/:id */
export const update = authedController.createHandlers(validate('json', customerUpdateSchema), async (c) => {
  const { auth } = c.var;
  const input = c.req.valid('json');
  const existing = await findCustomer(auth, c.req.param('id'));
  if (input.homeBranchId) await usableBranch(auth, input.homeBranchId, 'homeBranchId');
  if (input.cnic && input.cnic !== existing.cnic) await assertCnicIsFree(auth, input.cnic, existing._id);

  const updated = await withTransaction(async () => {
    const result = await Customer.findOneAndUpdate(
      { _id: existing._id, orgId: auth.orgId },
      { $set: input },
      { returnDocument: 'after' },
    ).populate(withHomeBranch(auth.orgId)).lean();
    if (!result) throw new NotFoundError('Customer');
    await recordAudit(auth, {
      action: 'customer.updated',
      entity: 'customer',
      entityId: existing._id,
      branchId: existing.homeBranchId,
      summary: `Updated customer ${input.fullName ?? existing.fullName}`,
      metadata: { fields: Object.keys(input) },
    });
    return result;
  });
  return c.json({ data: updated });
});

/** DELETE /customers/:id: owners only, for a customer added by mistake. */
export const remove = authedController.createHandlers(async (c) => {
  const { auth } = c.var;
  const existing = await findCustomer(auth, c.req.param('id'));
  if (await Contract.exists({ orgId: auth.orgId, customerId: existing._id })) {
    throw new ConflictError("A customer with contracts can't be deleted");
  }

  await withTransaction(async () => {
    await Customer.deleteOne({ _id: existing._id, orgId: auth.orgId });
    await recordAudit(auth, { action: 'customer.deleted', entity: 'customer', entityId: existing._id, branchId: existing.homeBranchId, summary: `Deleted customer ${existing.fullName}` });
  });
  return c.json({ data: { ok: true } });
});


/** GET /customers/:id/overview: profile and a bounded page of contracts in one response. */
export const overview = authedController.createHandlers(validate('query', pageQuerySchema), async (c) => {
  const { auth } = c.var;
  const customerId = parseId(c.req.param('id'), 'Customer');
  const [customer, contracts] = await Promise.all([
    findCustomer(auth, String(customerId)),
    paginate(Contract.find({ orgId: auth.orgId, customerId })
      .populate({ path: 'branch', select: 'name', match: { orgId: auth.orgId } }).lean(), c.req.valid('query')),
  ]);
  return c.json({ data: { customer, contracts } });
});
