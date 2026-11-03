import { planCreateSchema, planUpdateSchema } from '@shop/shared';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { NotFoundError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { validate } from '../lib/validate';
import { InstallmentPlan } from '../models/installment_plan';

/** GET /plans: everyone reads them (the sale wizard offers the active ones). */
export const list = authedController.createHandlers(async (c) => {
  const plans = await InstallmentPlan.find({ orgId: c.var.auth.orgId }).sort({ active: -1, count: 1 }).lean();
  return c.json({ data: plans });
});

/** POST /plans */
export const create = authedController.createHandlers(validate('json', planCreateSchema), async (c) => {
  const { auth } = c.var;
  const plan = await withTransaction(async () => {
    const created = await InstallmentPlan.create({ ...c.req.valid('json'), orgId: auth.orgId });
    await recordAudit(auth, { action: 'plan.created', entity: 'plan', entityId: created._id, summary: `Added plan ${created.name}` });
    return created;
  });
  return c.json({ data: plan }, 201);
});

/** PATCH /plans/:id: changes apply to new sales only; existing contracts keep their terms. */
export const update = authedController.createHandlers(validate('json', planUpdateSchema), async (c) => {
  const { auth } = c.var;
  const input = c.req.valid('json');
  const _id = parseId(c.req.param('id'), 'Plan');
  const plan = await withTransaction(async () => {
    const updated = await InstallmentPlan.findOneAndUpdate({ _id, orgId: auth.orgId }, { $set: input }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundError('Plan');
    await recordAudit(auth, { action: 'plan.updated', entity: 'plan', entityId: _id, summary: `Updated plan ${updated.name}`, metadata: { fields: Object.keys(input) } });
    return updated;
  });
  return c.json({ data: plan });
});
