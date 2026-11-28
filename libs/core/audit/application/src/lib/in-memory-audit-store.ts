import type { AuditEvent, AuditScope, ChainHead } from '@hk/core/audit/domain';
import type { AuditStore } from './ports';

/**
 * An audit store that keeps events in memory. For tests and local tools.
 *
 * It is one business's-worth of isolation by key: events are filed under
 * "tenant/business", so one scope never sees another's.
 */
export class InMemoryAuditStore implements AuditStore {
  private readonly chains = new Map<string, AuditEvent[]>();

  private chain(scope: AuditScope): AuditEvent[] {
    const key = `${scope.tenantId}/${scope.businessId}`;
    let chain = this.chains.get(key);
    if (!chain) {
      chain = [];
      this.chains.set(key, chain);
    }
    return chain;
  }

  async head(scope: AuditScope): Promise<ChainHead | null> {
    const chain = this.chain(scope);
    const last = chain[chain.length - 1];
    return last ? { sequence: last.sequence, hash: last.hash } : null;
  }

  async append(
    scope: AuditScope,
    seal: (head: ChainHead | null) => AuditEvent,
  ): Promise<AuditEvent> {
    // Nothing is awaited between reading the head and storing the event, so
    // two appends cannot be given the same head.
    const chain = this.chain(scope);
    const last = chain[chain.length - 1];
    const event = seal(
      last ? { sequence: last.sequence, hash: last.hash } : null,
    );
    const stored: AuditEvent = Object.freeze({ ...event });
    chain.push(stored);
    return stored;
  }

  async read(
    scope: AuditScope,
    query: { afterSequence: number; limit: number },
  ): Promise<AuditEvent[]> {
    return this.chain(scope)
      .filter((event) => event.sequence > query.afterSequence)
      .slice(0, query.limit);
  }

  /**
   * FOR TESTS: replaces what is stored, behind the store's back, the way
   * someone with database access could. Lets a test prove tampering shows.
   */
  tamper(
    scope: AuditScope,
    change: (events: AuditEvent[]) => AuditEvent[],
  ): void {
    const chain = this.chain(scope);
    const changed = change([...chain]);
    chain.length = 0;
    chain.push(...changed);
  }
}
