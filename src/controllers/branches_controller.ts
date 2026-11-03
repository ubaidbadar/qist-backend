import { branchCreateSchema, branchUpdateSchema } from '@shop/shared';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { ConflictError, NotFoundError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { scopeFilter } from '../lib/scope';
import { validate } from '../lib/validate';
import { Branch } from '../models/branch';

/** GET /branches: owners see every branch, inactive ones too; others see the branches they are assigned to. */
export const list = authedController.createHandlers(async (c) => {
  const branches = await Branch.find(scopeFilter(c.var.auth, '_id')).sort({ name: 1 }).lean();
  return c.json({ data: branches });
});

/** POST /branches */
export const create = authedController.createHandlers(validate('json', branchCreateSchema), async (c) => {
  const { auth } = c.var;
  const branch = await withTransaction(async () => {
    const created = await Branch.create({ ...c.req.valid('json'), orgId: auth.orgId });
    await recordAudit(auth, { action: 'branch.created', entity: 'branch', entityId: created._id, branchId: created._id, summary: `Added branch ${created.name}` });
    return created;
  });
  return c.json({ data: branch }, 201);
});

/** PATCH /branches/:id */
export const update = authedController.createHandlers(validate('json', branchUpdateSchema), async (c) => {
  const { auth } = c.var;
  const input = c.req.valid('json');
  const _id = parseId(c.req.param('id'), 'Branch');
  const existing = await Branch.findOne({ _id, orgId: auth.orgId }).lean();
  if (!existing) throw new NotFoundError('Branch');
  if (input.active === false && existing.active && (await Branch.countDocuments({ orgId: auth.orgId, active: true })) <= 1) {
    throw new ConflictError('Keep at least one active branch');
  }

  const branch = await withTransaction(async () => {
    const updated = await Branch.findOneAndUpdate({ _id, orgId: auth.orgId }, { $set: input }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundError('Branch');
    await recordAudit(auth, {
      action: 'branch.updated',
      entity: 'branch',
      entityId: _id,
      branchId: _id,
      summary: `Updated branch ${updated.name}`,
      metadata: { fields: Object.keys(input) },
    });
    return updated;
  });
  return c.json({ data: branch });
});
