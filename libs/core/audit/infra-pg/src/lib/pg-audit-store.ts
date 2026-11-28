import type { AuditStore } from '@hk/core/audit/application';
import {
  AUDIT_ERRORS,
  type AuditAction,
  type AuditActorType,
  type AuditEvent,
  type AuditScope,
  type ChainHead,
  type JsonObject,
} from '@hk/core/audit/domain';
import {
  ScopedRepository,
  requireTenantContext,
  type Row,
} from '@hk/platform/db';
import { DomainError } from '@hk/platform/universal';
import { asc, desc, gt, sql } from 'drizzle-orm';
import type { AuditEventsTable } from './schema';

/**
 * The audit store on PostgreSQL.
 *
 * Every method runs inside withTenantTransaction, for the business of the
 * tenant context. Recording an event in the transaction that makes the change
 * is the point: both are saved, or neither is.
 *
 * It extends ScopedRepository for its tenant filter and insert, and exposes
 * no update or delete.
 */
export class PgAuditStore
  extends ScopedRepository<AuditEventsTable>
  implements AuditStore
{
  constructor(table: AuditEventsTable) {
    super(table);
  }

  /**
   * The scope is passed by the caller and also known from the tenant context.
   * They must agree: a caller cannot name one business while running as
   * another.
   */
  private assertScope(scope: AuditScope): void {
    const context = requireTenantContext();
    if (
      scope.tenantId !== context.tenantId ||
      scope.businessId !== context.businessId
    ) {
      throw new DomainError(
        AUDIT_ERRORS.SCOPE_MISMATCH,
        'The audit scope is not the business this work is running for.',
        { kind: 'invariant' },
      );
    }
  }

  async head(scope: AuditScope): Promise<ChainHead | null> {
    this.assertScope(scope);
    const rows = await this.transaction
      .select({ sequence: this.table.sequence, hash: this.table.hash })
      .from(this.table)
      .where(this.scope())
      .orderBy(desc(this.table.sequence))
      .limit(1);
    const last = rows[0];
    return last ? { sequence: last.sequence, hash: last.hash } : null;
  }

  async append(
    scope: AuditScope,
    seal: (head: ChainHead | null) => AuditEvent,
  ): Promise<AuditEvent> {
    this.assertScope(scope);
    // One writer at a time per business, until this transaction ends. Without
    // it two transactions would read the same head and both claim the next
    // sequence. The unique index would refuse the second; the lock makes it
    // wait its turn instead of failing.
    await this.transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`audit:${scope.businessId}`}, 0))`,
    );
    const head = await this.head(scope);
    const event = seal(head);

    const expectedSequence = head ? head.sequence + 1 : 1;
    if (
      event.tenantId !== scope.tenantId ||
      event.businessId !== scope.businessId ||
      event.sequence !== expectedSequence
    ) {
      throw new DomainError(
        AUDIT_ERRORS.SCOPE_MISMATCH,
        'The sealed audit event does not belong at the end of this chain.',
        { kind: 'invariant' },
      );
    }

    await this.insert({
      id: event.id,
      sequence: event.sequence,
      occurredAt: new Date(event.occurredAt),
      actorType: event.actor.type,
      actorId: event.actor.id,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      details: event.details,
      requestId: event.requestId,
      previousHash: event.previousHash,
      hash: event.hash,
    });
    return event;
  }

  async read(
    scope: AuditScope,
    query: { afterSequence: number; limit: number },
  ): Promise<AuditEvent[]> {
    this.assertScope(scope);
    const rows = await this.transaction
      .select()
      .from(this.table)
      .where(this.scope(gt(this.table.sequence, query.afterSequence)))
      .orderBy(asc(this.table.sequence))
      .limit(query.limit);
    return rows.map(toEvent);
  }
}

const toEvent = (row: Row<AuditEventsTable>): AuditEvent => ({
  tenantId: row.tenantId,
  businessId: row.businessId,
  sequence: row.sequence,
  previousHash: row.previousHash,
  id: row.id,
  occurredAt: row.occurredAt.toISOString(),
  actor: { type: row.actorType as AuditActorType, id: row.actorId },
  action: row.action as AuditAction,
  entityType: row.entityType,
  entityId: row.entityId,
  details: row.details as JsonObject,
  requestId: row.requestId,
  hash: row.hash,
});
