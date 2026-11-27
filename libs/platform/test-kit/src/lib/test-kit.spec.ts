import { DomainError, FixedClock, isUuidV7 } from '@hk/platform/universal';
import {
  ConformanceFailure,
  expectDomainError,
  expectEqual,
  expectRejection,
  expectTrue,
  scopedStoreConformance,
  type Note,
  type ScopedStoreSubject,
} from './conformance';
import {
  InMemoryScopedStore,
  sequentialIds,
  type ScopedStore,
  type StoredRow,
  type TenantScope,
} from './scoped-store';

const ids = sequentialIds(1);
const TENANT = ids();
const SCOPES = {
  a: { tenantId: TENANT, businessId: ids() },
  b: { tenantId: TENANT, businessId: ids() },
  otherTenant: { tenantId: ids(), businessId: ids() },
};

const subjectFor = (
  storeFor: (scope: TenantScope) => ScopedStore<Note>,
): ScopedStoreSubject => {
  const nextId = sequentialIds(2);
  return {
    run: (scope, action) => action(storeFor(scope)),
    nextId,
    scopes: SCOPES,
  };
};

describe('InMemoryScopedStore passes the scoped-store conformance suite', () => {
  for (const testCase of scopedStoreConformance) {
    it(testCase.name, async () => {
      const store = new InMemoryScopedStore<Note>();
      await testCase.run(subjectFor((scope) => store.for(scope)));
    });
  }
});

describe('the conformance suite catches a broken adapter', () => {
  /** Runs the whole suite and returns the names of the cases that failed. */
  const failures = async (
    storeFor: () => (scope: TenantScope) => ScopedStore<Note>,
  ): Promise<string[]> => {
    const failed: string[] = [];
    for (const testCase of scopedStoreConformance) {
      try {
        await testCase.run(subjectFor(storeFor()));
      } catch {
        failed.push(testCase.name);
      }
    }
    return failed;
  };

  /** A correct store, with one method replaced. */
  const broken =
    (
      breakIt: (
        good: ScopedStore<Note>,
        all: InMemoryScopedStore<Note>,
        scope: TenantScope,
      ) => Partial<ScopedStore<Note>>,
    ) =>
    () => {
      const all = new InMemoryScopedStore<Note>();
      return (scope: TenantScope): ScopedStore<Note> => {
        const good = all.for(scope);
        return { ...good, ...breakIt(good, all, scope) };
      };
    };

  it('passes a correct adapter', async () => {
    expect(await failures(broken(() => ({})))).toEqual([]);
  });

  it('an adapter that reads across businesses', async () => {
    const leaky = broken((_good, all) => ({
      // Looks the row up in every business of the tenant, not only its own.
      findById: async (id) => {
        for (const scope of Object.values(SCOPES)) {
          const row = await all.for(scope).findById(id);
          if (row) return row;
        }
        return undefined;
      },
    }));
    expect(await failures(leaky)).toContain(
      'cannot see a row of another business or another tenant',
    );
  });

  it('an adapter that ignores the version', async () => {
    const lastWriteWins = broken((good) => ({
      update: async (id, _expectedVersion, patch) => {
        const current = await good.findById(id);
        return good.update(id, current?.version ?? 1, patch);
      },
    }));
    expect(await failures(lastWriteWins)).toContain(
      'rejects an update from a stale version and keeps the newer value',
    );
  });

  it('an adapter that trusts tenant columns from the caller', async () => {
    const trusting = broken((good) => ({
      insert: async (values) => ({
        ...(await good.insert(values)),
        ...(values as Partial<StoredRow>),
      }),
    }));
    expect(await failures(trusting)).toContain(
      'ignores tenant columns a caller smuggles into an insert',
    );
  });

  it('an adapter that does not bump the version', async () => {
    const frozenVersion = broken((good) => ({
      update: async (id, expectedVersion, patch) => ({
        ...(await good.update(id, expectedVersion, patch)),
        version: expectedVersion,
      }),
    }));
    expect(await failures(frozenVersion)).toContain(
      'updates at the expected version and moves to the next',
    );
  });

  it('an adapter that returns its internal rows', async () => {
    const sharing = () => {
      const rows = new Map<string, StoredRow & Note>();
      return (scope: TenantScope): ScopedStore<Note> => {
        const good = new InMemoryScopedStore<Note>().for(scope);
        return {
          ...good,
          insert: async (values) => {
            const row = await good.insert(values);
            rows.set(row.id, row);
            return row;
          },
          findById: async (id) => rows.get(id),
        };
      };
    };
    expect(await failures(sharing)).toContain(
      'hands out copies: changing a returned row does not change the stored one',
    );
  });
});

describe('InMemoryScopedStore', () => {
  it('uses the given clock for createdAt and updatedAt', async () => {
    const clock = new FixedClock('2026-11-27T10:00:00.000Z');
    const store = new InMemoryScopedStore<Note>(clock).for(SCOPES.a);
    const id = ids();
    const inserted = await store.insert({ id, body: 'x' });
    clock.advance(5_000);
    const updated = await store.update(id, 1, { body: 'y' });
    expect(inserted.createdAt.toISOString()).toBe('2026-11-27T10:00:00.000Z');
    expect(updated.createdAt.toISOString()).toBe('2026-11-27T10:00:00.000Z');
    expect(updated.updatedAt.toISOString()).toBe('2026-11-27T10:00:05.000Z');
  });

  it('reports the versions on a stale update', async () => {
    const store = new InMemoryScopedStore<Note>().for(SCOPES.a);
    const id = ids();
    await store.insert({ id, body: 'x' });
    await store.update(id, 1, { body: 'y' });
    await expect(store.update(id, 1, { body: 'z' })).rejects.toMatchObject({
      code: 'ROW_STALE_VERSION',
      kind: 'conflict',
      details: { expectedVersion: 1, currentVersion: 2 },
    });
  });
});

describe('sequentialIds', () => {
  it('gives valid UUID v7 values in a predictable order', () => {
    const next = sequentialIds();
    const first = next();
    const second = next();
    expect(first).toBe('00000000-0000-7000-8000-000000000001');
    expect(second).toBe('00000000-0000-7000-8000-000000000002');
    expect(isUuidV7(first)).toBe(true);
  });

  it('keeps two seeds apart', () => {
    expect(sequentialIds(1)()).not.toBe(sequentialIds(2)());
    expect(sequentialIds(255)()).toBe('000000ff-0000-7000-8000-000000000001');
  });
});

describe('conformance assertions', () => {
  it('expectEqual compares serialised values', () => {
    expect(() => expectEqual({ a: [1, 2] }, { a: [1, 2] }, 'x')).not.toThrow();
    expect(() => expectEqual(undefined, undefined, 'x')).not.toThrow();
    expect(() => expectEqual({ a: 1 }, { a: 2 }, 'row')).toThrow(
      new ConformanceFailure('row: expected {"a":2}, got {"a":1}'),
    );
  });

  it('expectTrue fails with its message', () => {
    expect(() => expectTrue(true, 'fine')).not.toThrow();
    expect(() => expectTrue(false, 'must hold')).toThrow('must hold');
  });

  it('expectDomainError needs that exact code', async () => {
    const fail = (code: string) => async () => {
      throw new DomainError(code, 'x');
    };
    await expect(expectDomainError(fail('A'), 'A')).resolves.toBeUndefined();
    await expect(expectDomainError(fail('B'), 'A')).rejects.toThrow(
      'expected DomainError A, got DomainError B',
    );
    await expect(
      expectDomainError(async () => {
        throw new Error('plain');
      }, 'A'),
    ).rejects.toThrow('expected DomainError A, got Error: plain');
    await expect(expectDomainError(async () => 1, 'A')).rejects.toThrow(
      'but nothing was thrown',
    );
  });

  it('expectRejection needs any rejection', async () => {
    await expect(
      expectRejection(async () => {
        throw new Error('x');
      }, 'dup'),
    ).resolves.toBeUndefined();
    await expect(expectRejection(async () => 1, 'dup')).rejects.toThrow(
      'dup: expected a rejection',
    );
  });
});
