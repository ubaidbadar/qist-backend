import { memberActiveSchema, memberCreateSchema, memberUpdateSchema } from '@shop/shared';
import { acrossTenants } from '../db/tenant_guard';
import { withTransaction } from '../db/transaction';
import { recordAudit } from '../lib/audit';
import type { AuthUser } from '../lib/auth_user';
import { ConflictError, fieldDetails, NotFoundError, ValidationError } from '../lib/errors';
import { authedController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { hashPassword } from '../lib/passwords';
import { revokeAllSessions } from '../lib/session';
import { temporaryPassword } from '../lib/tokens';
import { validate } from '../lib/validate';
import { Branch } from '../models/branch';
import { User } from '../models/user';

/** The team: managers and staff. The owner manages them here but is not managed through it. */

async function findMember(auth: AuthUser, id: string | undefined) {
  const member = await User.findOne({ _id: parseId(id, 'Team member'), orgId: auth.orgId }).lean();
  if (!member) throw new NotFoundError('Team member');
  if (member.role === 'owner') throw new ValidationError("The owner can't be changed from the team list");
  return member;
}

/** Only active branches of this organization can be assigned. Duplicates are dropped. */
async function checkBranches(auth: AuthUser, ids: string[]) {
  const unique = [...new Set(ids)];
  const found = await Branch.find({ orgId: auth.orgId, _id: { $in: unique }, active: true }).select('_id').lean();
  if (found.length !== unique.length) {
    throw new ValidationError('Choose active branches of your organization', fieldDetails('branchIds', 'Unknown or inactive branch'));
  }
  return found.map((branch) => branch._id);
}

/** Saves a new password hash, signs the person out everywhere and records why. */
async function newTemporaryPassword() {
  const password = temporaryPassword();
  return { password, passwordHash: await hashPassword(password) };
}

/** GET /users */
export const list = authedController.createHandlers(async (c) => {
  const users = await User.find({ orgId: c.var.auth.orgId }).sort({ role: 1, fullName: 1 }).lean();
  return c.json({ data: users });
});

/** POST /users: the new member gets a temporary password, shown once, that they must change at first sign-in. */
export const create = authedController.createHandlers(validate('json', memberCreateSchema), async (c) => {
  const { auth } = c.var;
  const input = c.req.valid('json');
  if (await acrossTenants(User.exists({ email: input.email }))) {
    throw new ConflictError('An account with this email already exists', fieldDetails('email', 'Already registered'));
  }
  const branchIds = await checkBranches(auth, input.branchIds);
  const { password, passwordHash } = await newTemporaryPassword();

  const user = await withTransaction(async () => {
    const created = await User.create({ ...input, orgId: auth.orgId, branchIds, passwordHash, mustChangePassword: true });
    await recordAudit(auth, { action: 'user.created', entity: 'user', entityId: created._id, summary: `Added ${created.fullName} as ${created.role}` });
    return created;
  });
  return c.json({ data: { user, temporaryPassword: password } }, 201);
});

/** PATCH /users/:id: name, role and branches. */
export const update = authedController.createHandlers(validate('json', memberUpdateSchema), async (c) => {
  const { auth } = c.var;
  const { branchIds: requestedBranches, ...fields } = c.req.valid('json');
  const member = await findMember(auth, c.req.param('id'));
  const branchIds = requestedBranches && (await checkBranches(auth, requestedBranches));

  const user = await withTransaction(async () => {
    const updated = await User.findOneAndUpdate(
      { _id: member._id, orgId: auth.orgId },
      { $set: { ...fields, ...(branchIds ? { branchIds } : {}) } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundError('Team member');
    await recordAudit(auth, {
      action: 'user.updated',
      entity: 'user',
      entityId: updated._id,
      summary: `Updated ${updated.fullName}`,
      metadata: { fields: [...Object.keys(fields), ...(branchIds ? ['branchIds'] : [])] },
    });
    return updated;
  });
  return c.json({ data: user });
});

/** PATCH /users/:id/active: deactivating signs the person out on every device at once. */
export const setActive = authedController.createHandlers(validate('json', memberActiveSchema), async (c) => {
  const { auth } = c.var;
  const { active } = c.req.valid('json');
  const member = await findMember(auth, c.req.param('id'));

  const user = await withTransaction(async () => {
    const updated = await User.findOneAndUpdate(
      { _id: member._id, orgId: auth.orgId },
      { $set: { active }, ...(active ? {} : { $inc: { tokenVersion: 1 } }) },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundError('Team member');
    if (!active) await revokeAllSessions(updated._id);
    await recordAudit(auth, {
      action: active ? 'user.activated' : 'user.deactivated',
      entity: 'user',
      entityId: updated._id,
      summary: `${active ? 'Reactivated' : 'Deactivated'} ${updated.fullName}`,
    });
    return updated;
  });
  return c.json({ data: user });
});

/** POST /users/:id/temporary-password: for someone who forgot their password and has no access to email. */
export const issueTemporaryPassword = authedController.createHandlers(async (c) => {
  const { auth } = c.var;
  const member = await findMember(auth, c.req.param('id'));
  const { password, passwordHash } = await newTemporaryPassword();

  const user = await withTransaction(async () => {
    const updated = await User.findOneAndUpdate(
      { _id: member._id, orgId: auth.orgId },
      { $set: { passwordHash, mustChangePassword: true }, $inc: { tokenVersion: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundError('Team member');
    await revokeAllSessions(updated._id);
    await recordAudit(auth, { action: 'user.password_issued', entity: 'user', entityId: updated._id, summary: `Issued a temporary password to ${updated.fullName}` });
    return updated;
  });
  return c.json({ data: { user, temporaryPassword: password } });
});
