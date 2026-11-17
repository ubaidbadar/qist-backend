import { DEFAULT_DOCUMENT_POLICY, documentPolicySchema, orgSettingsUpdateSchema, orgLogoUpdateSchema, orgUpdateSchema, paymentSettingsSchema, policyUpdateSchema } from '@shop/shared';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import { ConflictError, NotFoundError } from '../lib/errors';
import { documentStorageReady } from '../documents/storage';
import { decodeOrgLogo } from '../lib/org_logo';
import { authedController } from '../lib/factory';
import { validate } from '../lib/validate';
import { Org } from '../models/org';
import { OrgLogo } from '../models/org_logo';

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

/** PATCH /org/logo: one optional image; store its bytes off the normal session path. */
export const updateLogo = authedController.createHandlers(validate('json', orgLogoUpdateSchema), async (c) => {
  const { auth } = c.var;
  const { logo } = c.req.valid('json');
  const data = logo ? decodeOrgLogo(logo) : null;
  const org = await withTransaction(async () => {
    const updated = await Org.findByIdAndUpdate(
      auth.orgId,
      { $set: { logoUpdatedAt: data ? new Date() : null } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundError('Organization');

    if (data && logo) {
      await OrgLogo.updateOne(
        { _id: auth.orgId },
        { $set: { contentType: logo.contentType, data } },
        { upsert: true },
      );
    } else {
      await OrgLogo.deleteOne({ _id: auth.orgId });
    }
    await recordAudit(auth, {
      action: 'org.logo_updated',
      entity: 'org',
      entityId: auth.orgId,
      summary: data ? 'Updated the shop logo' : 'Removed the shop logo',
    });
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

/** PATCH /org/payment-methods: owner-managed instructions, not payment processing. */
export const updatePaymentMethods = authedController.createHandlers(validate('json', paymentSettingsSchema), async (c) => {
  const { auth } = c.var;
  const org = await withTransaction(async () => {
    const updated = await Org.findByIdAndUpdate(auth.orgId, { $set: c.req.valid('json') }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundError('Organization');
    await recordAudit(auth, { action: 'org.updated', entity: 'org', entityId: auth.orgId, summary: 'Updated retailer payment instructions' });
    return updated;
  });
  return c.json({ data: org });
});

/** A single settings save commits both logo and business name; legacy endpoints stay supported. */
export const updateSettings = authedController.createHandlers(validate('json', orgSettingsUpdateSchema), async c => {
  const { auth } = c.var; const input = c.req.valid('json');
  const logoData = input.logo ? decodeOrgLogo(input.logo) : null;
  const org = await withTransaction(async () => {
    const updated = await Org.findOneAndUpdate({ _id: auth.orgId, ...(input.expectedUpdatedAt ? { updatedAt: new Date(input.expectedUpdatedAt) } : {}) }, { $set: { name: input.name, ...(input.logo !== undefined ? { logoUpdatedAt: logoData ? new Date() : null } : {}) } }, { returnDocument: 'after' }).lean();
    if (!updated) throw new ConflictError('Settings changed. Refresh before saving your changes.');
    if (input.logo !== undefined) {
      if (logoData && input.logo) await OrgLogo.updateOne({ _id: auth.orgId }, { $set: { contentType: input.logo.contentType, data: logoData } }, { upsert: true });
      else await OrgLogo.deleteOne({ _id: auth.orgId });
    }
    await recordAudit(auth, { action: 'org.updated', entity: 'org', entityId: auth.orgId, summary: 'Updated business settings', metadata: { fields: ['name', ...(input.logo !== undefined ? ['logo'] : [])] } });
    return updated;
  });
  return c.json({ data: org });
});
export const documentSettings = authedController.createHandlers(async c => {
  const org = await Org.findById(c.var.auth.orgId).select('documentPolicy').lean();
  if (!org) throw new NotFoundError('Organization');
  const policy = documentPolicySchema.safeParse(org.documentPolicy);
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { policy: policy.success ? policy.data : DEFAULT_DOCUMENT_POLICY, available: documentStorageReady() } });
});
export const updateDocumentSettings = authedController.createHandlers(validate('json', documentPolicySchema), async c => {
  const policy = c.req.valid('json');
  if (policy.enabled && !documentStorageReady()) throw new ConflictError('Private document storage and file checks must be ready before uploads can be enabled.');
  const org = await withTransaction(async () => {
    const updated = await Org.findByIdAndUpdate(c.var.auth.orgId, { $set: { documentPolicy: policy } }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundError('Organization');
    await recordAudit(c.var.auth, { action: 'org.document_policy_updated', entity: 'org', entityId: updated._id, summary: 'Updated document policy' }); return updated;
  });
  return c.json({ data: { policy: org.documentPolicy, available: documentStorageReady() } });
});
