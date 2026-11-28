import type { AuditEvent, AuditScope, ChainHead } from '@hk/core/audit/domain';

/**
 * Where audit events are kept. One implementation per runtime: PostgreSQL on
 * the server, memory in tests. Every implementation passes
 * auditStoreConformance.
 *
 * A store only adds and reads. It has no way to change or remove an event,
 * and the PostgreSQL one is also refused those rights by the database.
 */
export interface AuditStore {
  /** The end of the business's chain, or null when it has no events yet. */
  head(scope: AuditScope): Promise<ChainHead | null>;

  /**
   * Adds the next event to the business's chain.
   *
   * The store reads the head and calls `seal` with it; `seal` returns the
   * event to store. The store must do both as one step: two calls at the same
   * time for the same business must not be given the same head, or the chain
   * would fork. Returns the stored event.
   */
  append(
    scope: AuditScope,
    seal: (head: ChainHead | null) => AuditEvent,
  ): Promise<AuditEvent>;

  /**
   * Events of the business with a sequence greater than `afterSequence`, in
   * order, at most `limit` of them.
   */
  read(
    scope: AuditScope,
    query: { afterSequence: number; limit: number },
  ): Promise<AuditEvent[]>;
}
