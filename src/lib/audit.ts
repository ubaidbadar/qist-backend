import type { Types } from 'mongoose';
import { AuditLog } from '../models/audit_log';
import type { AuthUser } from './auth_user';

interface AuditEntry {
  action: string;
  entity: string;
  entityId: Types.ObjectId;
  summary: string;
  branchId?: Types.ObjectId;
  /** Field names and non-personal values only. */
  metadata?: Record<string, unknown>;
}

/** Records what `actor` did. Call it inside the same `withTransaction` as the change, so both happen or neither. */
export async function recordAudit(actor: AuthUser, { branchId, metadata = {}, ...entry }: AuditEntry) {
  await AuditLog.create({
    ...entry,
    orgId: actor.orgId,
    branchId: branchId ?? null,
    actor: { kind: 'user', userId: actor._id, name: actor.fullName },
    metadata,
  });
}

/** For changes made by a scheduled job rather than a person. */
export async function recordSystemAudit(orgId: Types.ObjectId, { branchId, metadata = {}, ...entry }: AuditEntry) {
  await AuditLog.create({ ...entry, orgId, branchId: branchId ?? null, actor: { kind: 'system', userId: null, name: 'System' }, metadata });
}
