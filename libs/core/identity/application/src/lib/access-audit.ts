import type { AuditLog } from '@hk/core/audit/application';
import type { AccessAudit } from './ports';

/**
 * Sends changes to access into the business's audit log (core/audit).
 *
 * The access use cases call it inside the business's unit of work, and the
 * audit log writes in the transaction that is open. So a change to a role
 * or a membership and its audit event are saved together or not at all:
 * there is no access change without a record, and no record of a change
 * that did not happen.
 */
export const createAccessAudit = (
  log: Pick<AuditLog, 'record'>,
): AccessAudit => ({
  record: async (scope, event) => {
    await log.record(scope, {
      actor:
        event.actorUserId === null
          ? { type: 'system', id: null }
          : { type: 'user', id: event.actorUserId },
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      details: event.details,
    });
  },
});
