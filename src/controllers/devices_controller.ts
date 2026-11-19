import { can, deviceCreateSchema, deviceListQuerySchema, deviceTransferSchema, deviceUpdateSchema, ENROLLMENT_TOKEN_TTL_MINUTES, type EnrollmentTicket } from '@shop/shared';
import type { Types } from 'mongoose';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import type { AuthUser } from '../lib/auth_user';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, fieldDetails } from '../lib/errors';
import { authedController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { paginate } from '../lib/paginate';
import { assertProvisioningConfigured, provisioningPayload } from '../lib/provisioning';
import { scopeFilter, usableBranch, worksAt } from '../lib/scope';
import { createTokenFor } from '../lib/tokens';
import { validate } from '../lib/validate';
import { Branch } from '../models/branch';
import { Device } from '../models/device';

/** Stock belongs to a branch: people see and change only the stock of branches they work at. */

const withBranch = (orgId: Types.ObjectId) => ({ path: 'branch', select: 'name', match: { orgId } });

/** Owners see what the shop paid; everyone else never receives the field. */
const costField = (auth: AuthUser) => (can(auth.role, 'stock.costs') ? '+costPrice' : '');

/** Digits search the start of an IMEI; anything else searches inside the brand or model. */
function searchFilter(q: string | undefined) {
  if (!q) return {};
  if (/^\d+$/.test(q)) return { imeis: { $regex: `^${q}` } };
  const text = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  return { $or: [{ brand: text }, { model: text }] };
}

async function findDevice(auth: AuthUser, id: string | undefined) {
  const device = await Device.findOne({ _id: parseId(id, 'Phone'), ...scopeFilter(auth) })
    .select(costField(auth))
    .populate<{ branch: { _id: Types.ObjectId; name: string } | null }>(withBranch(auth.orgId))
    .lean();
  if (!device) throw new NotFoundError('Phone');
  return device;
}

async function findInStock(auth: AuthUser, id: string | undefined) {
  const device = await findDevice(auth, id);
  if (device.stockStatus !== 'in_stock') throw new ConflictError('Only phones in stock can be changed');
  return device;
}

async function assertImeisAreFree(auth: AuthUser, imeis: string[], exceptId?: Types.ObjectId) {
  const existing = await Device.findOne({ orgId: auth.orgId, imeis: { $in: imeis }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .select('brand model')
    .lean();
  if (existing) {
    throw new ConflictError(`This IMEI is already registered (${existing.brand} ${existing.model})`, fieldDetails('imeis', 'Already registered'));
  }
}

/** GET /devices?branchId&status&q&limit&cursor */
export const list = authedController.createHandlers(validate('query', deviceListQuerySchema), async (c) => {
  const { auth } = c.var;
  const { branchId, status, q, ...page } = c.req.valid('query');
  if (branchId && !worksAt(auth, branchId)) throw new ForbiddenError("You don't work at that branch");

  const filter = { ...scopeFilter(auth), ...(branchId ? { branchId } : {}), ...(status ? { stockStatus: status } : {}), ...searchFilter(q) };
  const query = Device.find(filter).select(costField(auth)).populate(withBranch(auth.orgId)).lean();
  return c.json({ data: await paginate(query, page) });
});

/** GET /devices/:id: use the same branch scope and cost visibility as inventory. */
export const get = authedController.createHandlers(async (c) =>
  c.json({ data: await findDevice(c.var.auth, c.req.param('id')) }),
);

/** POST /devices */
export const create = authedController.createHandlers(validate('json', deviceCreateSchema), async (c) => {
  const { auth } = c.var;
  const { costPrice, ...input } = c.req.valid('json');
  const branchId = await usableBranch(auth, input.branchId, 'branchId');
  await assertImeisAreFree(auth, input.imeis);

  const device = await withTransaction(async () => {
    const created = await Device.create({
      ...input,
      branchId,
      costPrice: can(auth.role, 'stock.costs') ? costPrice : null,
      orgId: auth.orgId,
      createdBy: auth._id,
    });
    await recordAudit(auth, { action: 'device.created', entity: 'device', entityId: created._id, branchId, summary: `Added ${created.brand} ${created.model} to stock` });
    return created;
  });
  return c.json({ data: await findDevice(auth, String(device._id)) }, 201);
});

/** PATCH /devices/:id: only while the phone is in stock. */
export const update = authedController.createHandlers(validate('json', deviceUpdateSchema), async (c) => {
  const { auth } = c.var;
  const { costPrice, ...input } = c.req.valid('json');
  const existing = await findInStock(auth, c.req.param('id'));
  if (input.imeis) await assertImeisAreFree(auth, input.imeis, existing._id);
  const changes = can(auth.role, 'stock.costs') && costPrice !== undefined ? { ...input, costPrice } : input;

  const updated = await withTransaction(async () => {
    const result = await Device.findOneAndUpdate(
      { _id: existing._id, orgId: auth.orgId, stockStatus: 'in_stock' },
      { $set: changes },
      { returnDocument: 'after' },
    ).select(costField(auth)).populate(withBranch(auth.orgId)).lean();
    if (!result) throw new ConflictError('Only phones in stock can be changed');
    await recordAudit(auth, {
      action: 'device.updated',
      entity: 'device',
      entityId: existing._id,
      branchId: existing.branchId,
      summary: `Updated ${input.brand ?? existing.brand} ${input.model ?? existing.model}`,
      metadata: { fields: Object.keys(changes) },
    });
    return result;
  });
  return c.json({ data: updated });
});

/** POST /devices/:id/transfer: moves a phone in stock to another branch. */
export const transfer = authedController.createHandlers(validate('json', deviceTransferSchema), async (c) => {
  const { auth } = c.var;
  const existing = await findInStock(auth, c.req.param('id'));
  const requestedBranchId = c.req.valid('json').toBranchId;
  if (!worksAt(auth, requestedBranchId)) throw new ForbiddenError("You don't work at that branch");
  const toBranch = await Branch.findOne({ _id: requestedBranchId, orgId: auth.orgId, active: true }).select('name').lean();
  if (!toBranch) throw new ValidationError('Choose an active branch', fieldDetails('toBranchId', 'Unknown or inactive branch'));
  const toBranchId = toBranch._id;
  if (toBranchId.equals(existing.branchId)) {
    throw new ValidationError('The phone is already at this branch', fieldDetails('toBranchId', 'Choose another branch'));
  }

  const transferred = await withTransaction(async () => {
    const updated = await Device.findOneAndUpdate(
      { _id: existing._id, orgId: auth.orgId, stockStatus: 'in_stock' },
      { $set: { branchId: toBranchId } },
      { returnDocument: 'after' },
    ).select(costField(auth)).populate(withBranch(auth.orgId)).lean();
    if (!updated) throw new ConflictError('Only phones in stock can be changed');
    await recordAudit(auth, {
      action: 'device.transferred',
      entity: 'device',
      entityId: existing._id,
      branchId: toBranchId,
      summary: `Moved ${existing.brand} ${existing.model} from ${existing.branch?.name} to ${toBranch.name}`,
      metadata: { fromBranchId: existing.branchId, toBranchId },
    });
    return updated;
  });
  return c.json({ data: transferred });
});

/**
 * POST /devices/:id/enrollment: issue a one-time provisioning QR for a sold phone. Only its hash is stored; the
 * token travels back once, inside the QR scanned at the counter, and expires soon. Re-issuing replaces the old one.
 */
export const issueEnrollment = authedController.createHandlers(async (c) => {
  const { auth } = c.var;
  const device = await findDevice(auth, c.req.param('id'));
  if (device.stockStatus !== 'sold') throw new ConflictError('Only a sold phone can be enrolled');
  assertProvisioningConfigured();

  const { token, secretHash } = createTokenFor(device._id);
  const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MINUTES * 60 * 1000);
  await withTransaction(async () => {
    await Device.updateOne({ _id: device._id, orgId: auth.orgId }, { $set: { enrollToken: { secretHash, expiresAt } } });
    await recordAudit(auth, { action: 'device.enrollment_issued', entity: 'device', entityId: device._id, branchId: device.branchId, summary: `Issued an enrolment QR for ${device.brand} ${device.model}` });
  });

  const ticket: EnrollmentTicket = { deviceId: String(device._id), token, expiresAt: expiresAt.toISOString(), payload: provisioningPayload(token) };
  return c.json({ data: ticket }, 201);
});

/** DELETE /devices/:id/enrollment: revoke the QR and any active enrolment, so the phone can no longer check in. */
export const revokeEnrollment = authedController.createHandlers(async (c) => {
  const { auth } = c.var;
  const device = await findDevice(auth, c.req.param('id'));
  if (!device.enrollToken && !device.enrollment) throw new ConflictError('This phone is not enrolled');

  await withTransaction(async () => {
    await Device.updateOne({ _id: device._id, orgId: auth.orgId }, { $unset: { enrollToken: 1, enrollment: 1 } });
    await recordAudit(auth, { action: 'device.enrollment_revoked', entity: 'device', entityId: device._id, branchId: device.branchId, summary: `Revoked enrolment for ${device.brand} ${device.model}` });
  });
  return c.json({ data: { ok: true } });
});

/** DELETE /devices/:id: owners only, for a phone entered by mistake that was never sold. */
export const remove = authedController.createHandlers(async (c) => {
  const { auth } = c.var;
  const existing = await findInStock(auth, c.req.param('id'));

  await withTransaction(async () => {
    await Device.deleteOne({ _id: existing._id, orgId: auth.orgId });
    await recordAudit(auth, { action: 'device.deleted', entity: 'device', entityId: existing._id, branchId: existing.branchId, summary: `Deleted ${existing.brand} ${existing.model} from stock` });
  });
  return c.json({ data: { ok: true } });
});
