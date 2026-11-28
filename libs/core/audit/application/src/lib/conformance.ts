import {
  sealEvent,
  verifyChain,
  type AuditEvent,
  type AuditScope,
  type ChainHead,
  type NewAuditEvent,
  type Sha256,
} from '@hk/core/audit/domain';
import {
  ConformanceFailure,
  expectEqual,
  expectTrue,
  type ConformanceCase,
} from '@hk/platform/test-kit';
import type { AuditStore } from './ports';

/**
 * What every AuditStore must do, whatever it stores events in.
 *
 * Each adapter's test file runs these cases against itself:
 *
 *   for (const testCase of auditStoreConformance) {
 *     it(testCase.name, () => testCase.run(subject));
 *   }
 *
 * Each case must start with empty chains for both scopes.
 */
export interface AuditStoreSubject {
  store: AuditStore;
  sha256: Sha256;
  /** Two different businesses. */
  scopeA: AuditScope;
  scopeB: AuditScope;
  /**
   * Runs store calls the way the adapter needs them run. A PostgreSQL store
   * needs a tenant transaction for the scope; an in-memory one just calls
   * `action`. Each call is its own unit of work.
   */
  within<T>(scope: AuditScope, action: () => Promise<T>): Promise<T>;
}

type Case = ConformanceCase<AuditStoreSubject>;

const newEvent = (
  n: number,
  overrides: Partial<NewAuditEvent> = {},
): NewAuditEvent => ({
  id: `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
  occurredAt: `2026-11-28T09:00:${String(n % 60).padStart(2, '0')}.${String(n % 1000).padStart(3, '0')}Z`,
  actor: { type: 'user', id: '018f0000-0000-7000-8000-0000000000aa' },
  action: 'update',
  entityType: 'sales.invoice',
  entityId: `inv-${n}`,
  details: { n, note: 'changed' },
  requestId: `req-${n}`,
  ...overrides,
});

const add = (
  subject: AuditStoreSubject,
  scope: AuditScope,
  event: NewAuditEvent,
): Promise<AuditEvent> =>
  subject.within(scope, () =>
    subject.store.append(scope, (head) =>
      sealEvent(head, scope, event, subject.sha256),
    ),
  );

const readAll = (
  subject: AuditStoreSubject,
  scope: AuditScope,
): Promise<AuditEvent[]> =>
  subject.within(scope, () =>
    subject.store.read(scope, { afterSequence: 0, limit: 1000 }),
  );

const headOf = (
  subject: AuditStoreSubject,
  scope: AuditScope,
): Promise<ChainHead | null> =>
  subject.within(scope, () => subject.store.head(scope));

export const auditStoreConformance: readonly Case[] = [
  {
    name: 'a business with no events has no head and nothing to read',
    run: async (subject) => {
      expectEqual(await headOf(subject, subject.scopeA), null, 'head');
      expectEqual(await readAll(subject, subject.scopeA), [], 'events');
    },
  },
  {
    name: 'append stores the event that seal returns, and returns it',
    run: async (subject) => {
      const { scopeA } = subject;
      const stored = await add(subject, scopeA, newEvent(1));
      const expected = sealEvent(null, scopeA, newEvent(1), subject.sha256);
      expectEqual(stored, expected, 'the returned event');
      expectEqual(
        await readAll(subject, scopeA),
        [expected],
        'what was stored',
      );
      expectEqual(
        await headOf(subject, scopeA),
        { sequence: 1, hash: expected.hash },
        'head after one event',
      );
    },
  },
  {
    name: 'seal is given the current head: nothing first, then the last event',
    run: async (subject) => {
      const { scopeA, store } = subject;
      const seen: (ChainHead | null)[] = [];
      for (let n = 1; n <= 3; n += 1) {
        await subject.within(scopeA, () =>
          store.append(scopeA, (head) => {
            seen.push(head);
            return sealEvent(head, scopeA, newEvent(n), subject.sha256);
          }),
        );
      }
      const events = await readAll(subject, scopeA);
      expectEqual(
        seen,
        [
          null,
          { sequence: 1, hash: events[0]?.hash },
          { sequence: 2, hash: events[1]?.hash },
        ],
        'the heads seal was given',
      );
    },
  },
  {
    name: 'events appended one after another form an intact chain, read back in order',
    run: async (subject) => {
      const { scopeA } = subject;
      for (let n = 1; n <= 12; n += 1) {
        await add(subject, scopeA, newEvent(n));
      }
      const events = await readAll(subject, scopeA);
      expectEqual(
        events.map((event) => event.sequence),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        'sequences',
      );
      const result = verifyChain(scopeA, events, subject.sha256);
      expectTrue(result.ok, 'the chain verifies');
      expectEqual(
        await headOf(subject, scopeA),
        result.ok ? result.head : null,
        'head',
      );
    },
  },
  {
    name: 'events appended at the same time do not fork the chain',
    run: async (subject) => {
      const { scopeA } = subject;
      const count = 12;
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          add(subject, scopeA, newEvent(index + 1)),
        ),
      );
      const events = await readAll(subject, scopeA);
      expectEqual(events.length, count, 'every event was stored');
      expectEqual(
        events.map((event) => event.sequence),
        Array.from({ length: count }, (_, index) => index + 1),
        'each event has its own sequence',
      );
      const result = verifyChain(scopeA, events, subject.sha256);
      if (!result.ok) {
        throw new ConformanceFailure(
          `the chain is broken at ${result.brokenAt}: ${result.reason}`,
        );
      }
    },
  },
  {
    name: 'read returns events after a sequence, up to a limit',
    run: async (subject) => {
      const { scopeA, store } = subject;
      for (let n = 1; n <= 7; n += 1) {
        await add(subject, scopeA, newEvent(n));
      }
      const read = (afterSequence: number, limit: number) =>
        subject.within(scopeA, async () =>
          (await store.read(scopeA, { afterSequence, limit })).map(
            (event) => event.sequence,
          ),
        );
      expectEqual(await read(0, 3), [1, 2, 3], 'the first page');
      expectEqual(await read(3, 3), [4, 5, 6], 'the second page');
      expectEqual(await read(6, 3), [7], 'the last page');
      expectEqual(await read(7, 3), [], 'past the end');
      expectEqual(await read(100, 3), [], 'far past the end');
    },
  },
  {
    name: 'each business has its own chain, and sees only its own events',
    run: async (subject) => {
      const { scopeA, scopeB } = subject;
      await add(subject, scopeA, newEvent(1));
      await add(subject, scopeA, newEvent(2));
      expectEqual(
        await headOf(subject, scopeB),
        null,
        "B's head before B appends",
      );
      expectEqual(
        await readAll(subject, scopeB),
        [],
        "B's events before B appends",
      );

      const first = await add(subject, scopeB, newEvent(3));
      expectEqual(first.sequence, 1, "B's first event starts B's chain");
      expectEqual(
        (await readAll(subject, scopeA)).map((event) => event.id),
        [newEvent(1).id, newEvent(2).id],
        "A's events are unchanged",
      );
      expectEqual(
        (await readAll(subject, scopeB)).map((event) => event.id),
        [newEvent(3).id],
        "B's events",
      );
      expectTrue(
        verifyChain(scopeA, await readAll(subject, scopeA), subject.sha256).ok,
        "A's chain verifies",
      );
      expectTrue(
        verifyChain(scopeB, await readAll(subject, scopeB), subject.sha256).ok,
        "B's chain verifies",
      );
    },
  },
  {
    name: 'an event comes back exactly as it was stored',
    run: async (subject) => {
      const { scopeA } = subject;
      const inputs: NewAuditEvent[] = [
        newEvent(1, {
          details: {
            zebra: 1,
            apple: { nested: [1, 'two', null, true, { deep: 'é ü 漢字 😀' }] },
            empty: {},
            list: [],
            big: 9007199254740991,
            negative: -42,
            text: 'quotes " and \\ backslashes \n newlines',
          },
        }),
        newEvent(2, {
          actor: { type: 'system', id: null },
          action: 'login_failed',
          entityType: 'core.user',
          entityId: null,
          requestId: null,
          details: {},
        }),
        newEvent(3, {
          actor: { type: 'service', id: 'sales' },
          occurredAt: '2026-01-02T03:04:05.006Z',
        }),
      ];
      const stored: AuditEvent[] = [];
      for (const input of inputs) {
        stored.push(await add(subject, scopeA, input));
      }
      const events = await readAll(subject, scopeA);
      expectEqual(events.length, inputs.length, 'number of events');
      events.forEach((event, index) => {
        const original = stored[index];
        if (!original) throw new ConformanceFailure('an event is missing');
        for (const key of [
          'id',
          'tenantId',
          'businessId',
          'sequence',
          'occurredAt',
          'action',
          'entityType',
          'entityId',
          'requestId',
          'previousHash',
          'hash',
        ] as const) {
          expectEqual(event[key], original[key], `event ${index + 1} ${key}`);
        }
        expectEqual(
          { type: event.actor.type, id: event.actor.id },
          { type: original.actor.type, id: original.actor.id },
          `event ${index + 1} actor`,
        );
      });
      // The details may come back with their keys in another order. What
      // matters is that the hash still matches, which verifyChain checks.
      const result = verifyChain(scopeA, events, subject.sha256);
      if (!result.ok) {
        throw new ConformanceFailure(
          `an event changed in storage: broken at ${result.brokenAt} (${result.reason})`,
        );
      }
    },
  },
  {
    name: 'when seal fails, nothing is stored',
    run: async (subject) => {
      const { scopeA, store } = subject;
      await add(subject, scopeA, newEvent(1));
      let failed = false;
      try {
        await subject.within(scopeA, () =>
          store.append(scopeA, () => {
            throw new Error('seal failed');
          }),
        );
      } catch {
        failed = true;
      }
      expectTrue(failed, 'append rejects when seal throws');
      expectEqual(
        (await readAll(subject, scopeA)).map((event) => event.sequence),
        [1],
        'events after the failure',
      );
      const next = await add(subject, scopeA, newEvent(2));
      expectEqual(next.sequence, 2, 'the next event takes the next sequence');
    },
  },
];
