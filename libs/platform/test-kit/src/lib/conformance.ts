import { isDomainError } from '@hk/platform/universal';
import type { ScopedStore, TenantScope } from './scoped-store';

/**
 * Port conformance.
 *
 * A port is an interface the application layer defines, and each runtime
 * implements it differently: PostgreSQL on the server, SQLite on a device, in
 * memory in tests. A conformance suite is the list of behaviours every one of
 * those implementations must share. Each adapter's test file runs the same
 * suite against its own implementation:
 *
 *   describe('PgNoteStore', () => {
 *     for (const testCase of scopedStoreConformance) {
 *       it(testCase.name, () => testCase.run(subject));
 *     }
 *   });
 *
 * The cases use no test framework, only the tiny assertions below, so the
 * same suite runs under Jest, under Vitest and on the Hermes target.
 */
export interface ConformanceCase<Subject> {
  name: string;
  run(subject: Subject): Promise<void>;
}

/** Thrown by a conformance case when the adapter does not behave as the port requires. */
export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

const show = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value);

/** Fails unless the two values are the same once serialised. */
export const expectEqual = (
  actual: unknown,
  expected: unknown,
  what: string,
): void => {
  if (show(actual) !== show(expected)) {
    throw new ConformanceFailure(
      `${what}: expected ${show(expected)}, got ${show(actual)}`,
    );
  }
};

export const expectTrue = (condition: boolean, what: string): void => {
  if (!condition) {
    throw new ConformanceFailure(what);
  }
};

/** Fails unless the action rejects with a DomainError carrying this code. */
export const expectDomainError = async (
  action: () => Promise<unknown>,
  code: string,
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    if (isDomainError(error) && error.code === code) {
      return;
    }
    throw new ConformanceFailure(
      `expected DomainError ${code}, got ${
        isDomainError(error) ? `DomainError ${error.code}` : String(error)
      }`,
    );
  }
  throw new ConformanceFailure(
    `expected DomainError ${code}, but nothing was thrown`,
  );
};

/** Fails unless the action rejects, with anything. */
export const expectRejection = async (
  action: () => Promise<unknown>,
  what: string,
): Promise<void> => {
  try {
    await action();
  } catch {
    return;
  }
  throw new ConformanceFailure(`${what}: expected a rejection`);
};

/** The row the scoped-store conformance suite stores. */
export interface Note {
  body: string;
}

/**
 * What an adapter's test file provides so the suite can drive it.
 *
 * `run` executes `action` as one unit of work for one business: on PostgreSQL
 * that is a tenant context plus a transaction, in memory it is just a view.
 * The store must start empty for each case.
 */
export interface ScopedStoreSubject {
  run<Result>(
    scope: TenantScope,
    action: (store: ScopedStore<Note>) => Promise<Result>,
  ): Promise<Result>;
  /** A new unique id, as the caller of a real use case would generate. */
  nextId(): string;
  /** Two businesses of one tenant, and a business of another tenant. */
  scopes: { a: TenantScope; b: TenantScope; otherTenant: TenantScope };
}

export const scopedStoreConformance: ConformanceCase<ScopedStoreSubject>[] = [
  {
    name: 'stamps tenant, business, creating user and version 1 on insert',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      const user = nextId();
      const row = await run({ ...scopes.a, userId: user }, (store) =>
        store.insert({ id, body: 'hello' }),
      );
      expectEqual(
        {
          id: row.id,
          tenantId: row.tenantId,
          businessId: row.businessId,
          createdBy: row.createdBy,
          version: row.version,
          body: row.body,
        },
        {
          id,
          tenantId: scopes.a.tenantId,
          businessId: scopes.a.businessId,
          createdBy: user,
          version: 1,
          body: 'hello',
        },
        'inserted row',
      );
      expectTrue(row.createdAt instanceof Date, 'createdAt is a Date');
      expectTrue(row.updatedAt instanceof Date, 'updatedAt is a Date');
    },
  },
  {
    name: 'leaves createdBy null when there is no user',
    run: async ({ run, nextId, scopes }) => {
      const row = await run(scopes.a, (store) =>
        store.insert({ id: nextId(), body: 'system' }),
      );
      expectEqual(row.createdBy, null, 'createdBy');
    },
  },
  {
    name: 'ignores tenant columns a caller smuggles into an insert',
    run: async ({ run, nextId, scopes }) => {
      const smuggled = {
        id: nextId(),
        body: 'x',
        tenantId: scopes.otherTenant.tenantId,
        businessId: scopes.b.businessId,
        version: 99,
      };
      const row = await run(scopes.a, (store) => store.insert(smuggled));
      expectEqual(
        [row.tenantId, row.businessId, row.version],
        [scopes.a.tenantId, scopes.a.businessId, 1],
        'stamped columns',
      );
    },
  },
  {
    name: 'refuses a second row with the same id',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      await run(scopes.a, (store) => store.insert({ id, body: 'first' }));
      await expectRejection(
        () => run(scopes.a, (store) => store.insert({ id, body: 'second' })),
        'duplicate id',
      );
    },
  },
  {
    name: 'finds a row of its own business by id',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      await run(scopes.a, (store) => store.insert({ id, body: 'mine' }));
      const found = await run(scopes.a, (store) => store.findById(id));
      expectEqual(found?.body, 'mine', 'found row');
      expectEqual(
        await run(scopes.a, (store) => store.findById(nextId())),
        undefined,
        'unknown id',
      );
    },
  },
  {
    name: 'cannot see a row of another business or another tenant',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      await run(scopes.a, (store) => store.insert({ id, body: 'secret of A' }));
      for (const intruder of [scopes.b, scopes.otherTenant]) {
        expectEqual(
          await run(intruder, (store) => store.findById(id)),
          undefined,
          'findById by an intruder',
        );
        expectEqual(
          (await run(intruder, (store) => store.list())).length,
          0,
          'list by an intruder',
        );
      }
    },
  },
  {
    name: 'lists only the rows of its own business',
    run: async ({ run, nextId, scopes }) => {
      await run(scopes.a, (store) =>
        store.insert({ id: nextId(), body: 'a1' }),
      );
      await run(scopes.b, (store) =>
        store.insert({ id: nextId(), body: 'b1' }),
      );
      await run(scopes.a, (store) =>
        store.insert({ id: nextId(), body: 'a2' }),
      );
      const bodies = (await run(scopes.a, (store) => store.list()))
        .map((row) => row.body)
        .sort();
      expectEqual(bodies, ['a1', 'a2'], 'rows of A');
    },
  },
  {
    name: 'updates at the expected version and moves to the next',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      const inserted = await run(scopes.a, (store) =>
        store.insert({ id, body: 'v1' }),
      );
      const updated = await run(scopes.a, (store) =>
        store.update(id, 1, { body: 'v2' }),
      );
      expectEqual([updated.body, updated.version], ['v2', 2], 'updated row');
      expectEqual(updated.createdBy, inserted.createdBy, 'createdBy is kept');
      expectTrue(
        updated.updatedAt.getTime() >= inserted.updatedAt.getTime(),
        'updatedAt does not go backwards',
      );
      const reloaded = await run(scopes.a, (store) => store.findById(id));
      expectEqual(
        [reloaded?.body, reloaded?.version],
        ['v2', 2],
        'reloaded row',
      );
    },
  },
  {
    name: 'rejects an update from a stale version and keeps the newer value',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      await run(scopes.a, (store) => store.insert({ id, body: 'v1' }));
      await run(scopes.a, (store) => store.update(id, 1, { body: 'v2' }));
      await expectDomainError(
        () => run(scopes.a, (store) => store.update(id, 1, { body: 'lost' })),
        'ROW_STALE_VERSION',
      );
      const row = await run(scopes.a, (store) => store.findById(id));
      expectEqual(
        [row?.body, row?.version],
        ['v2', 2],
        'row after the stale update',
      );
    },
  },
  {
    name: 'reports a missing row on update',
    run: async ({ run, nextId, scopes }) => {
      await expectDomainError(
        () =>
          run(scopes.a, (store) => store.update(nextId(), 1, { body: 'x' })),
        'ROW_NOT_FOUND',
      );
    },
  },
  {
    name: 'cannot update or delete a row of another business',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      await run(scopes.b, (store) => store.insert({ id, body: 'theirs' }));
      await expectDomainError(
        () =>
          run(scopes.a, (store) => store.update(id, 1, { body: 'defaced' })),
        'ROW_NOT_FOUND',
      );
      expectEqual(
        await run(scopes.a, (store) => store.delete(id)),
        false,
        'delete by another business',
      );
      const row = await run(scopes.b, (store) => store.findById(id));
      expectEqual(
        [row?.body, row?.version],
        ['theirs', 1],
        'the row is untouched',
      );
    },
  },
  {
    name: 'cannot move a row to another business through an update',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      await run(scopes.a, (store) => store.insert({ id, body: 'mine' }));
      const patch = { body: 'still mine', businessId: scopes.b.businessId };
      const updated = await run(scopes.a, (store) =>
        store.update(id, 1, patch),
      );
      expectEqual(updated.businessId, scopes.a.businessId, 'businessId');
      expectEqual(
        await run(scopes.b, (store) => store.findById(id)),
        undefined,
        'the row did not move',
      );
    },
  },
  {
    name: 'deletes a row of its own business, once',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      await run(scopes.a, (store) => store.insert({ id, body: 'bye' }));
      expectEqual(
        await run(scopes.a, (store) => store.delete(id)),
        true,
        'first delete',
      );
      expectEqual(
        await run(scopes.a, (store) => store.delete(id)),
        false,
        'second delete',
      );
      expectEqual(
        await run(scopes.a, (store) => store.findById(id)),
        undefined,
        'after delete',
      );
    },
  },
  {
    name: 'hands out copies: changing a returned row does not change the stored one',
    run: async ({ run, nextId, scopes }) => {
      const id = nextId();
      const inserted = await run(scopes.a, (store) =>
        store.insert({ id, body: 'original' }),
      );
      inserted.body = 'mutated';
      inserted.version = 42;
      const found = await run(scopes.a, (store) => store.findById(id));
      expectEqual([found?.body, found?.version], ['original', 1], 'stored row');
    },
  },
];
