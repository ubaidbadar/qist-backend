import { orgUpdateSchema, policyUpdateSchema } from '@shop/shared';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { NotFoundError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { validate } from '../lib/validate';
import { Org } from '../models/org';

/** GET /org */
export const show = authedController.createHandlers(async (c) => {
  const org = await Org.findById(c.var.auth.orgId).lean();
  if (!org) throw new NotFoundError('Organization');
  return c.json({ data: org });
});

/** PATCH /org */
export const update = authedController.createHandlers(validate('json', orgUpdateSchema), async (c) => {
  const { auth } = c.var;
  const org = await withTransaction(async () => {
    const updated = await Org.findByIdAndUpdate(auth.orgId, { $set: c.req.valid('json') }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundError('Organization');
    await recordAudit(auth, { action: 'org.updated', entity: 'org', entityId: auth.orgId, summary: `Renamed the organization to ${updated.name}` });
    return updated;
  });
  return c.json({ data: org });
});

/** PATCH /org/policy: lock policy and late fee. Only the fields sent change. */
export const updatePolicy = authedController.createHandlers(validate('json', policyUpdateSchema), async (c) => {
  const { auth } = c.var;
  const { lockPolicy = {}, lateFee = {} } = c.req.valid('json');
  const changes = Object.fromEntries([
    ...Object.entries(lockPolicy).map(([key, value]) => [`lockPolicy.${key}`, value]),
    ...Object.entries(lateFee).map(([key, value]) => [`lateFee.${key}`, value]),
  ]);
  const org = await withTransaction(async () => {
    const updated = await Org.findByIdAndUpdate(auth.orgId, { $set: changes }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundError('Organization');
    await recordAudit(auth, { action: 'org.policy_updated', entity: 'org', entityId: auth.orgId, summary: 'Changed the lock and late-fee policy', metadata: { fields: Object.keys(changes) } });
    return updated;
  });
  return c.json({ data: org });
});
