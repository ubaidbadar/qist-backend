import type { Types } from 'mongoose';
import { AuditLog } from '../models/audit_log';
import type { DocumentContext, Principal } from './access';
import { actorId } from './access';
export const documentAudit = (
  principal: Principal,
  context: DocumentContext,
  id: Types.ObjectId,
  action: string,
) =>
  AuditLog.create({
    orgId: context.orgId,
    branchId: context.branchId,
    entity: 'document',
    entityId: id,
    action,
    summary: 'Document record changed',
    metadata: {},
    actor:
      principal.kind === 'staff'
        ? { kind: 'user', userId: principal.auth._id, name: principal.auth.fullName }
        : { kind: 'customer', customerAccountId: actorId(principal), name: 'Customer' },
  });
