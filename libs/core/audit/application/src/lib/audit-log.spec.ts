import {
  AUDIT_ERRORS,
  GENESIS_HASH,
  hashOf,
  insecureTestHash,
  type AuditEvent,
  type AuditScope,
  type ChainHead,
  type JsonObject,
} from '@hk/core/audit/domain';
import { sequentialIds } from '@hk/platform/test-kit';
import { FixedClock, isDomainError } from '@hk/platform/universal';
import {
  AUDIT_USE_CASES,
  createAuditLog,
  type AuditLog,
  type RecordAuditInput,
} from './audit-log';
import { auditStoreConformance, type AuditStoreSubject } from './conformance';
import { InMemoryAuditStore } from './in-memory-audit-store';
import type { AuditStore } from './ports';

const scopeA: AuditScope = {
  tenantId: '018f0000-0000-7000-8000-00000000000a',
  businessId: '018f0000-0000-7000-8000-00000000000b',
};
const scopeB: AuditScope = {
  tenantId: scopeA.tenantId,
  businessId: '018f0000-0000-7000-8000-00000000000c',
};
const userId = '018f0000-0000-7000-8000-0000000000aa';

const input = (
  overrides: Partial<RecordAuditInput> = {},
): RecordAuditInput => ({
  actor: { type: 'user', id: userId },
  action: 'update',
  entityType: 'sales.invoice',
  entityId: 'inv-1',
  details: { field: 'status', to: 'issued' },
  requestId: 'req-1',
  ...overrides,
});

const codeOfRejection = async (
  action: () => Promise<unknown>,
): Promise<string> => {
  try {
    await action();
  } catch (error) {
    return isDomainError(error) ? error.code : String(error);
  }
  return 'nothing was thrown';
};

describe('audit log', () => {
  let store: InMemoryAuditStore;
  let clock: FixedClock;
  let log: AuditLog;

  beforeEach(() => {
    store = new InMemoryAuditStore();
    clock = new FixedClock('2026-11-28T09:00:00.000Z');
    log = createAuditLog({
      store,
      sha256: insecureTestHash,
      clock,
      newId: sequentialIds(1),
    });
  });

  const fill = async (count: number, scope = scopeA): Promise<AuditEvent[]> => {
    const events: AuditEvent[] = [];
    for (let n = 1; n <= count; n += 1) {
      events.push(await log.record(scope, input({ entityId: `inv-${n}` })));
    }
    return events;
  };

  it('declares that no audit use case runs offline', () => {
    expect(AUDIT_USE_CASES).toEqual({
      record: { name: 'core.audit.record', offline: false },
      list: { name: 'core.audit.list', offline: false },
      verify: { name: 'core.audit.verify', offline: false },
    });
  });

  describe('record', () => {
    it('stamps the id and the time, and starts the chain', async () => {
      const event = await log.record(scopeA, input());
      expect(event).toEqual({
        ...scopeA,
        sequence: 1,
        previousHash: GENESIS_HASH,
        id: '00000001-0000-7000-8000-000000000001',
        occurredAt: '2026-11-28T09:00:00.000Z',
        actor: { type: 'user', id: userId },
        action: 'update',
        entityType: 'sales.invoice',
        entityId: 'inv-1',
        details: { field: 'status', to: 'issued' },
        requestId: 'req-1',
        hash: event.hash,
      });
      expect(event.hash).toBe(hashOf(event, insecureTestHash));
    });

    it('links each event to the one before', async () => {
      const first = await log.record(scopeA, input());
      clock.set('2026-11-28T09:05:00.000Z');
      const second = await log.record(scopeA, input({ action: 'approve' }));
      expect(second.sequence).toBe(2);
      expect(second.previousHash).toBe(first.hash);
      expect(second.occurredAt).toBe('2026-11-28T09:05:00.000Z');
    });

    it('defaults the optional fields', async () => {
      const event = await log.record(scopeA, {
        actor: { type: 'system', id: null },
        action: 'login_failed',
        entityType: 'core.user',
      });
      expect(event.entityId).toBeNull();
      expect(event.requestId).toBeNull();
      expect(event.details).toEqual({});
    });

    it('keeps one chain per business', async () => {
      await fill(3, scopeA);
      const first = await log.record(scopeB, input());
      expect(first.sequence).toBe(1);
      expect(first.previousHash).toBe(GENESIS_HASH);
      expect(first.businessId).toBe(scopeB.businessId);
    });

    it('refuses an invalid event and stores nothing', async () => {
      expect(
        await codeOfRejection(() =>
          log.record(scopeA, input({ entityType: 'Invoice' })),
        ),
      ).toBe(AUDIT_ERRORS.EVENT_INVALID);
      expect(
        await codeOfRejection(() =>
          log.record(scopeA, input({ details: { amount: 19.25 } })),
        ),
      ).toBe(AUDIT_ERRORS.DETAILS_INVALID);
      expect(await store.head(scopeA)).toBeNull();
    });

    it('does not use up a sequence number on a refused event', async () => {
      await log.record(scopeA, input());
      await codeOfRejection(() =>
        log.record(scopeA, input({ entityType: '' })),
      );
      const next = await log.record(scopeA, input());
      expect(next.sequence).toBe(2);
    });

    it('applies the redactor before hashing, so the masked text is what is recorded', async () => {
      const redacting = createAuditLog({
        store,
        sha256: insecureTestHash,
        clock,
        newId: sequentialIds(2),
        redact: (details): JsonObject => ({
          ...details,
          password: '[REDACTED]',
        }),
      });
      const event = await redacting.record(
        scopeA,
        input({ details: { password: 'hunter2', field: 'login' } }),
      );
      expect(event.details).toEqual({ password: '[REDACTED]', field: 'login' });
      expect(
        JSON.stringify(
          await store.read(scopeA, { afterSequence: 0, limit: 10 }),
        ),
      ).not.toContain('hunter2');
      expect((await redacting.verify(scopeA)).ok).toBe(true);
    });

    it('records events made at the same moment without forking the chain', async () => {
      await Promise.all(
        Array.from({ length: 25 }, (_, n) =>
          log.record(scopeA, input({ entityId: `inv-${n}` })),
        ),
      );
      const result = await log.verify(scopeA);
      expect(result).toMatchObject({ ok: true, checked: 25 });
    });
  });

  describe('list', () => {
    it('returns events in order, a page at a time', async () => {
      await fill(7);
      const sequences = async (query?: Parameters<AuditLog['list']>[1]) =>
        (await log.list(scopeA, query)).map((event) => event.sequence);
      expect(await sequences()).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(await sequences({ limit: 3 })).toEqual([1, 2, 3]);
      expect(await sequences({ afterSequence: 3, limit: 3 })).toEqual([
        4, 5, 6,
      ]);
      expect(await sequences({ afterSequence: 7 })).toEqual([]);
    });

    it('shows a business only its own events', async () => {
      await fill(3, scopeA);
      expect(await log.list(scopeB)).toEqual([]);
    });

    it.each([
      [{ limit: 0 }],
      [{ limit: 501 }],
      [{ limit: 1.5 }],
      [{ afterSequence: -1 }],
    ])('refuses %j', async (query) => {
      expect(await codeOfRejection(() => log.list(scopeA, query))).toBe(
        AUDIT_ERRORS.EVENT_INVALID,
      );
    });
  });

  describe('verify', () => {
    it('accepts an empty chain', async () => {
      expect(await log.verify(scopeA)).toEqual({
        ok: true,
        checked: 0,
        head: null,
      });
    });

    it('accepts an intact chain and reports its head', async () => {
      const events = await fill(12);
      const last = events[11];
      expect(await log.verify(scopeA)).toEqual({
        ok: true,
        checked: 12,
        head: { sequence: 12, hash: last?.hash },
      });
    });

    it.each([1, 2, 5, 12, 13, 500])(
      'gives the same answer reading %i events at a time',
      async (pageSize) => {
        await fill(12);
        expect(await log.verify(scopeA, { pageSize })).toMatchObject({
          ok: true,
          checked: 12,
        });
      },
    );

    it('catches an event edited in storage', async () => {
      await fill(10);
      store.tamper(scopeA, (events) =>
        events.map((event) =>
          event.sequence === 6
            ? { ...event, details: { field: 'total', to: '0' } }
            : event,
        ),
      );
      expect(await log.verify(scopeA, { pageSize: 4 })).toEqual({
        ok: false,
        reason: 'hash',
        brokenAt: 6,
        checked: 5,
      });
    });

    it('catches an event removed from storage', async () => {
      await fill(10);
      store.tamper(scopeA, (events) =>
        events.filter((event) => event.sequence !== 4),
      );
      expect(await log.verify(scopeA, { pageSize: 3 })).toEqual({
        ok: false,
        reason: 'sequence',
        brokenAt: 5,
        checked: 3,
      });
    });

    it('catches an edit whose hash was recomputed', async () => {
      await fill(10);
      store.tamper(scopeA, (events) =>
        events.map((event) => {
          if (event.sequence !== 3) return event;
          const edited = { ...event, details: { forged: true } };
          return { ...edited, hash: hashOf(edited, insecureTestHash) };
        }),
      );
      expect(await log.verify(scopeA, { pageSize: 3 })).toMatchObject({
        ok: false,
        reason: 'previous_hash',
        brokenAt: 4,
        checked: 3,
      });
    });

    it('catches events cut off the end, given a saved head', async () => {
      const events = await fill(10);
      const last = events[9];
      if (!last) throw new Error('no last event');
      const saved: ChainHead = { sequence: last.sequence, hash: last.hash };
      expect((await log.verify(scopeA, { expectedHead: saved })).ok).toBe(true);

      store.tamper(scopeA, (all) => all.slice(0, 7));
      // On its own the shorter chain looks intact.
      expect((await log.verify(scopeA)).ok).toBe(true);
      expect(await log.verify(scopeA, { expectedHead: saved })).toEqual({
        ok: false,
        reason: 'head',
        brokenAt: 10,
        checked: 7,
      });
    });

    it('checks one business without being fooled by another', async () => {
      await fill(5, scopeA);
      await fill(5, scopeB);
      store.tamper(scopeB, (events) => events.slice(1));
      expect((await log.verify(scopeA)).ok).toBe(true);
      expect((await log.verify(scopeB)).ok).toBe(false);
    });

    it('refuses a page size that makes no sense', async () => {
      expect(
        await codeOfRejection(() => log.verify(scopeA, { pageSize: 0 })),
      ).toBe(AUDIT_ERRORS.EVENT_INVALID);
    });
  });
});

const subjectFor = (store: AuditStore): AuditStoreSubject => ({
  store,
  sha256: insecureTestHash,
  scopeA,
  scopeB,
  within: (_scope, action) => action(),
});

describe('InMemoryAuditStore conformance', () => {
  for (const testCase of auditStoreConformance) {
    it(testCase.name, () => testCase.run(subjectFor(new InMemoryAuditStore())));
  }
});

describe('the conformance suite notices a store that', () => {
  /** A broken store: an in-memory store with some methods replaced. */
  const broken = (
    wrap: (inner: InMemoryAuditStore) => Partial<AuditStore>,
  ): AuditStore => {
    const inner = new InMemoryAuditStore();
    const overrides = wrap(inner);
    return {
      head: overrides.head ?? ((scope) => inner.head(scope)),
      append: overrides.append ?? ((scope, seal) => inner.append(scope, seal)),
      read: overrides.read ?? ((scope, query) => inner.read(scope, query)),
    };
  };

  /** Names of the cases a store fails. Each case gets a new store. */
  const run = async (
    wrap: (inner: InMemoryAuditStore) => Partial<AuditStore>,
  ): Promise<string[]> => {
    const failed: string[] = [];
    for (const testCase of auditStoreConformance) {
      try {
        await testCase.run(subjectFor(broken(wrap)));
      } catch {
        failed.push(testCase.name);
      }
    }
    return failed;
  };

  it('is sound: a store with nothing replaced fails nothing', async () => {
    expect(await run(() => ({}))).toEqual([]);
  });

  it('gives every append the same head, forking the chain', async () => {
    const failed = await run((inner) => ({
      append: async (scope, seal) => {
        const head = await inner.head(scope);
        // A gap between reading the head and storing, as in a store with no lock.
        await Promise.resolve();
        return inner.append(scope, () => seal(head));
      },
    }));
    expect(failed).toContain(
      'events appended at the same time do not fork the chain',
    );
  });

  it('mixes two businesses into one chain', async () => {
    const shared: AuditScope = scopeA;
    const failed = await run((inner) => ({
      head: () => inner.head(shared),
      append: (_scope, seal) => inner.append(shared, seal),
      read: (_scope, query) => inner.read(shared, query),
    }));
    expect(failed).toContain(
      'each business has its own chain, and sees only its own events',
    );
  });

  it('changes an event on the way in', async () => {
    const failed = await run((inner) => ({
      append: (scope, seal) =>
        inner.append(scope, (head) => ({
          ...seal(head),
          details: { replaced: true },
        })),
    }));
    expect(failed).toContain(
      'append stores the event that seal returns, and returns it',
    );
    expect(failed).toContain('an event comes back exactly as it was stored');
  });

  it('drops milliseconds from the time', async () => {
    const failed = await run((inner) => ({
      read: async (scope, query) =>
        (await inner.read(scope, query)).map((event) => ({
          ...event,
          occurredAt: `${event.occurredAt.slice(0, 19)}.000Z`,
        })),
    }));
    expect(failed).toContain('an event comes back exactly as it was stored');
  });

  it('returns events out of order', async () => {
    const failed = await run((inner) => ({
      read: async (scope, query) => (await inner.read(scope, query)).reverse(),
    }));
    expect(failed).toContain(
      'events appended one after another form an intact chain, read back in order',
    );
  });

  it('ignores the read limit', async () => {
    const failed = await run((inner) => ({
      read: (scope, query) => inner.read(scope, { ...query, limit: 1000 }),
    }));
    expect(failed).toEqual([
      'read returns events after a sequence, up to a limit',
    ]);
  });

  it('ignores where to read from', async () => {
    const failed = await run((inner) => ({
      read: (scope, query) => inner.read(scope, { ...query, afterSequence: 0 }),
    }));
    expect(failed).toEqual([
      'read returns events after a sequence, up to a limit',
    ]);
  });

  it('stores something even when seal fails', async () => {
    const failed = await run((inner) => ({
      append: async (scope, seal) => {
        try {
          return await inner.append(scope, seal);
        } catch (error) {
          const head = await inner.head(scope);
          await inner.append(scope, () => ({
            tenantId: scope.tenantId,
            businessId: scope.businessId,
            sequence: (head?.sequence ?? 0) + 1,
            previousHash: head?.hash ?? GENESIS_HASH,
            id: '018f0000-0000-7000-8000-0000000000ff',
            occurredAt: '2026-11-28T09:00:00.000Z',
            actor: { type: 'system', id: null },
            action: 'create',
            entityType: 'core.junk',
            entityId: null,
            details: {},
            requestId: null,
            hash: 'f'.repeat(64),
          }));
          throw error;
        }
      },
    }));
    expect(failed).toEqual(['when seal fails, nothing is stored']);
  });

  it('never reports a head', async () => {
    const failed = await run(() => ({ head: async () => null }));
    expect(failed).toContain(
      'append stores the event that seal returns, and returns it',
    );
  });
});
