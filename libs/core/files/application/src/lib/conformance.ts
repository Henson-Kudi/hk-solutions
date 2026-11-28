import { FILE_ERRORS, type FileScope } from '@hk/core/files/domain';
import {
  ConformanceFailure,
  expectEqual,
  expectTrue,
  type ConformanceCase,
} from '@hk/platform/test-kit';
import { isDomainError } from '@hk/platform/universal';
import type {
  ByteStream,
  FileRecords,
  FileStorage,
  NewFileRecord,
} from './ports';
import { collectBytes, streamOf } from './streams';

/**
 * What every FileStorage and every FileRecords must do. Each adapter's test
 * file runs these against itself:
 *
 *   for (const testCase of fileStorageConformance) {
 *     it(testCase.name, () => testCase.run(subject));
 *   }
 */

// ── FileStorage ─────────────────────────────────────────────────────────────

export interface FileStorageSubject {
  storage: FileStorage;
  /** A key nothing is stored under. A new one on every call. */
  newKey(): string;
}

type StorageCase = ConformanceCase<FileStorageSubject>;

/** `length` bytes that are not all the same, so a mix-up shows. */
const pattern = (length: number, seed = 0): Uint8Array => {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = (index * 31 + seed * 7 + (index >>> 8)) & 0xff;
  }
  return out;
};

const inChunks = (bytes: Uint8Array, chunkSize: number): ByteStream => {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += chunkSize) {
    chunks.push(bytes.subarray(start, start + chunkSize));
  }
  return streamOf(...chunks);
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
};

const expectBytes = (
  actual: Uint8Array,
  expected: Uint8Array,
  what: string,
) => {
  if (!sameBytes(actual, expected)) {
    throw new ConformanceFailure(
      `${what}: expected ${expected.length} bytes, got ${actual.length} bytes or different content`,
    );
  }
};

const rejectionCode = async (
  action: () => Promise<unknown>,
): Promise<string | undefined> => {
  try {
    await action();
  } catch (error) {
    return isDomainError(error)
      ? error.code
      : `not a DomainError: ${String(error)}`;
  }
  return undefined;
};

/** A stream that yields some chunks, then fails. */
const failingAfter = (chunks: Uint8Array[], error: Error): ByteStream => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const chunk = chunks[index];
        if (chunk === undefined) {
          throw error;
        }
        index += 1;
        return { done: false, value: chunk };
      },
    };
  },
});

export const fileStorageConformance: readonly StorageCase[] = [
  {
    name: 'what is put can be read back, byte for byte',
    run: async ({ storage, newKey }) => {
      const key = newKey();
      const bytes = pattern(10_000);
      const result = await storage.put(key, inChunks(bytes, 1024), {
        contentType: 'application/pdf',
      });
      expectEqual(result.size, bytes.length, 'size reported by put');
      const object = await storage.get(key);
      expectEqual(object.size, bytes.length, 'size reported by get');
      expectEqual(object.contentType, 'application/pdf', 'content type');
      expectBytes(await collectBytes(object.body), bytes, 'content');
    },
  },
  {
    name: 'every byte value survives, including zero',
    run: async ({ storage, newKey }) => {
      const key = newKey();
      const bytes = new Uint8Array(512);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index & 0xff;
      }
      await storage.put(key, streamOf(bytes), {
        contentType: 'application/zip',
      });
      expectBytes(
        await collectBytes((await storage.get(key)).body),
        bytes,
        'content',
      );
    },
  },
  {
    name: 'a large file arriving in small pieces is stored whole',
    run: async ({ storage, newKey }) => {
      const key = newKey();
      // Larger than the 5 MB part size object stores split uploads at.
      const bytes = pattern(6 * 1024 * 1024 + 123, 3);
      const result = await storage.put(key, inChunks(bytes, 64 * 1024), {
        contentType: 'application/zip',
      });
      expectEqual(result.size, bytes.length, 'size reported by put');
      const object = await storage.get(key);
      expectEqual(object.size, bytes.length, 'size reported by get');
      expectBytes(await collectBytes(object.body), bytes, 'content');
    },
  },
  {
    name: 'a file can arrive as one piece, as many, or with empty pieces between',
    run: async ({ storage, newKey }) => {
      const bytes = pattern(3000, 5);
      const empty = new Uint8Array(0);
      const streams: [string, ByteStream][] = [
        ['one piece', streamOf(bytes)],
        ['one byte at a time', inChunks(bytes.subarray(0, 300), 1)],
        [
          'with empty pieces',
          streamOf(empty, bytes.subarray(0, 1000), empty, bytes.subarray(1000)),
        ],
      ];
      for (const [what, stream] of streams) {
        const key = newKey();
        await storage.put(key, stream, { contentType: 'text/csv' });
        const expected =
          what === 'one byte at a time' ? bytes.subarray(0, 300) : bytes;
        expectBytes(
          await collectBytes((await storage.get(key)).body),
          expected,
          what,
        );
      }
    },
  },
  {
    name: 'reading a key that holds nothing is FILE_OBJECT_NOT_FOUND',
    run: async ({ storage, newKey }) => {
      expectEqual(
        await rejectionCode(() => storage.get(newKey())),
        FILE_ERRORS.OBJECT_NOT_FOUND,
        'get on a missing key',
      );
    },
  },
  {
    name: 'exists says whether a key holds something',
    run: async ({ storage, newKey }) => {
      const key = newKey();
      expectEqual(await storage.exists(key), false, 'before put');
      await storage.put(key, streamOf(pattern(10)), {
        contentType: 'text/plain',
      });
      expectEqual(await storage.exists(key), true, 'after put');
      expectEqual(await storage.exists(newKey()), false, 'another key');
    },
  },
  {
    name: 'delete removes the object, and deleting again is not an error',
    run: async ({ storage, newKey }) => {
      const key = newKey();
      await storage.put(key, streamOf(pattern(10)), {
        contentType: 'text/plain',
      });
      await storage.delete(key);
      expectEqual(await storage.exists(key), false, 'after delete');
      expectEqual(
        await rejectionCode(() => storage.get(key)),
        FILE_ERRORS.OBJECT_NOT_FOUND,
        'get after delete',
      );
      await storage.delete(key);
      await storage.delete(newKey());
    },
  },
  {
    name: 'put replaces what a key held',
    run: async ({ storage, newKey }) => {
      const key = newKey();
      await storage.put(key, streamOf(pattern(500, 1)), {
        contentType: 'text/plain',
      });
      const second = pattern(200, 2);
      await storage.put(key, streamOf(second), { contentType: 'text/csv' });
      const object = await storage.get(key);
      expectEqual(object.contentType, 'text/csv', 'content type after replace');
      expectBytes(
        await collectBytes(object.body),
        second,
        'content after replace',
      );
    },
  },
  {
    name: 'keys are independent of each other',
    run: async ({ storage, newKey }) => {
      const first = newKey();
      const second = newKey();
      await storage.put(first, streamOf(pattern(100, 1)), {
        contentType: 'text/plain',
      });
      await storage.put(second, streamOf(pattern(100, 2)), {
        contentType: 'text/plain',
      });
      await storage.delete(first);
      expectBytes(
        await collectBytes((await storage.get(second)).body),
        pattern(100, 2),
        'the other key',
      );
    },
  },
  {
    name: 'when the stream fails part-way, put rejects with that error and stores nothing',
    run: async ({ storage, newKey }) => {
      const key = newKey();
      const failure = new Error('the upload was cut off');
      let caught: unknown;
      try {
        await storage.put(
          key,
          failingAfter([pattern(1000), pattern(1000, 1)], failure),
          { contentType: 'application/pdf' },
        );
      } catch (error) {
        caught = error;
      }
      expectTrue(caught === failure, 'put rejects with the stream’s own error');
      expectEqual(
        await storage.exists(key),
        false,
        'nothing stored under the key',
      );
    },
  },
  {
    name: 'a failed put leaves what the key held before',
    run: async ({ storage, newKey }) => {
      const key = newKey();
      const original = pattern(300, 4);
      await storage.put(key, streamOf(original), { contentType: 'text/plain' });
      try {
        await storage.put(
          key,
          failingAfter([pattern(100)], new Error('cut off')),
          { contentType: 'text/csv' },
        );
      } catch {
        // expected
      }
      const object = await storage.get(key);
      expectEqual(
        object.contentType,
        'text/plain',
        'content type is unchanged',
      );
      expectBytes(
        await collectBytes(object.body),
        original,
        'content is unchanged',
      );
    },
  },
];

// ── FileRecords ─────────────────────────────────────────────────────────────

export interface FileRecordsSubject {
  records: FileRecords;
  /** Two different businesses. Each case starts with no records for either. */
  scopeA: FileScope;
  scopeB: FileScope;
  /** Runs record calls as the adapter needs: a tenant transaction on PostgreSQL. */
  within<T>(scope: FileScope, action: () => Promise<T>): Promise<T>;
}

type RecordsCase = ConformanceCase<FileRecordsSubject>;

const fileId = (n: number): string =>
  `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const newRecord = (
  scope: FileScope,
  n: number,
  overrides: Partial<NewFileRecord> = {},
): NewFileRecord => ({
  id: fileId(n),
  purpose: 'attachment',
  name: `file-${n}.pdf`,
  contentType: 'application/pdf',
  objectKey: `tenants/${scope.tenantId}/businesses/${scope.businessId}/files/${fileId(n)}`,
  createdAt: '2026-11-28T09:00:00.123Z',
  createdBy: '018f0000-0000-7000-8000-0000000000aa',
  ...overrides,
});

const SHA = 'ab'.repeat(32);

export const fileRecordsConformance: readonly RecordsCase[] = [
  {
    name: 'create adds a pending record, with nothing known about the bytes yet',
    run: async ({ records, scopeA, within }) => {
      const input = newRecord(scopeA, 1);
      const created = await within(scopeA, () => records.create(scopeA, input));
      const expected = {
        ...input,
        tenantId: scopeA.tenantId,
        businessId: scopeA.businessId,
        status: 'pending',
        size: null,
        sha256: null,
      };
      const pick = (record: unknown) => {
        const row = record as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(expected)
            .sort()
            .map((key) => [key, row[key]]),
        );
      };
      expectEqual(pick(created), pick(expected), 'the created record');
      const found = await within(scopeA, () => records.find(scopeA, input.id));
      expectEqual(pick(found), pick(expected), 'the record read back');
    },
  },
  {
    name: 'find returns null for an id the business does not have',
    run: async ({ records, scopeA, within }) => {
      expectEqual(
        await within(scopeA, () => records.find(scopeA, fileId(404))),
        null,
        'an unknown id',
      );
    },
  },
  {
    name: 'a record keeps a null creator and every purpose and type',
    run: async ({ records, scopeA, within }) => {
      const input = newRecord(scopeA, 2, {
        purpose: 'import',
        contentType: 'text/csv',
        name: 'reçu café فاتورة.csv',
        createdBy: null,
      });
      await within(scopeA, () => records.create(scopeA, input));
      const found = await within(scopeA, () => records.find(scopeA, input.id));
      expectEqual(found?.purpose, 'import', 'purpose');
      expectEqual(found?.contentType, 'text/csv', 'content type');
      expectEqual(found?.name, 'reçu café فاتورة.csv', 'name');
      expectEqual(found?.createdBy, null, 'creator');
      expectEqual(found?.createdAt, '2026-11-28T09:00:00.123Z', 'created at');
    },
  },
  {
    name: 'markStored moves a pending record to stored, with its size and hash',
    run: async ({ records, scopeA, within }) => {
      const input = newRecord(scopeA, 3);
      await within(scopeA, () => records.create(scopeA, input));
      const stored = await within(scopeA, () =>
        records.markStored(scopeA, input.id, { size: 12345, sha256: SHA }),
      );
      expectEqual(
        [stored.status, stored.size, stored.sha256],
        ['stored', 12345, SHA],
        'the returned record',
      );
      const found = await within(scopeA, () => records.find(scopeA, input.id));
      expectEqual(
        [found?.status, found?.size, found?.sha256, found?.name],
        ['stored', 12345, SHA, input.name],
        'the record read back',
      );
    },
  },
  {
    name: 'markStored works once: not on a stored, deleted or unknown record',
    run: async ({ records, scopeA, within }) => {
      const input = newRecord(scopeA, 4);
      await within(scopeA, () => records.create(scopeA, input));
      const mark = () =>
        within(scopeA, () =>
          records.markStored(scopeA, input.id, { size: 1, sha256: SHA }),
        );
      await mark();
      expectEqual(
        await rejectionCode(mark),
        FILE_ERRORS.NOT_FOUND,
        'a second time',
      );
      await within(scopeA, () => records.markDeleted(scopeA, input.id));
      expectEqual(
        await rejectionCode(mark),
        FILE_ERRORS.NOT_FOUND,
        'when deleted',
      );
      expectEqual(
        await rejectionCode(() =>
          within(scopeA, () =>
            records.markStored(scopeA, fileId(404), { size: 1, sha256: SHA }),
          ),
        ),
        FILE_ERRORS.NOT_FOUND,
        'an unknown id',
      );
    },
  },
  {
    name: 'markDeleted moves a stored record to deleted, and keeps it',
    run: async ({ records, scopeA, within }) => {
      const input = newRecord(scopeA, 5);
      await within(scopeA, () => records.create(scopeA, input));
      await within(scopeA, () =>
        records.markStored(scopeA, input.id, { size: 9, sha256: SHA }),
      );
      const deleted = await within(scopeA, () =>
        records.markDeleted(scopeA, input.id),
      );
      expectEqual(deleted.status, 'deleted', 'the returned record');
      const found = await within(scopeA, () => records.find(scopeA, input.id));
      expectEqual(
        [found?.status, found?.size, found?.sha256],
        ['deleted', 9, SHA],
        'the record is kept as a trace',
      );
    },
  },
  {
    name: 'markDeleted works only on a stored record',
    run: async ({ records, scopeA, within }) => {
      const input = newRecord(scopeA, 6);
      await within(scopeA, () => records.create(scopeA, input));
      const remove = () =>
        within(scopeA, () => records.markDeleted(scopeA, input.id));
      expectEqual(
        await rejectionCode(remove),
        FILE_ERRORS.NOT_FOUND,
        'when pending',
      );
      await within(scopeA, () =>
        records.markStored(scopeA, input.id, { size: 1, sha256: SHA }),
      );
      await remove();
      expectEqual(
        await rejectionCode(remove),
        FILE_ERRORS.NOT_FOUND,
        'a second time',
      );
    },
  },
  {
    name: 'discardPending removes a pending record and nothing else',
    run: async ({ records, scopeA, within }) => {
      const pending = newRecord(scopeA, 7);
      const stored = newRecord(scopeA, 8);
      await within(scopeA, () => records.create(scopeA, pending));
      await within(scopeA, () => records.create(scopeA, stored));
      await within(scopeA, () =>
        records.markStored(scopeA, stored.id, { size: 1, sha256: SHA }),
      );

      await within(scopeA, () => records.discardPending(scopeA, pending.id));
      await within(scopeA, () => records.discardPending(scopeA, stored.id));
      await within(scopeA, () => records.discardPending(scopeA, fileId(404)));

      expectEqual(
        await within(scopeA, () => records.find(scopeA, pending.id)),
        null,
        'the pending record is gone',
      );
      const kept = await within(scopeA, () => records.find(scopeA, stored.id));
      expectEqual(kept?.status, 'stored', 'the stored record is untouched');
    },
  },
  {
    name: 'one business cannot see or change another’s records',
    run: async ({ records, scopeA, scopeB, within }) => {
      const input = newRecord(scopeA, 9);
      await within(scopeA, () => records.create(scopeA, input));
      await within(scopeA, () =>
        records.markStored(scopeA, input.id, { size: 1, sha256: SHA }),
      );

      expectEqual(
        await within(scopeB, () => records.find(scopeB, input.id)),
        null,
        'B looking up A’s file',
      );
      expectEqual(
        await rejectionCode(() =>
          within(scopeB, () => records.markDeleted(scopeB, input.id)),
        ),
        FILE_ERRORS.NOT_FOUND,
        'B deleting A’s file',
      );
      await within(scopeB, () => records.discardPending(scopeB, input.id));

      const found = await within(scopeA, () => records.find(scopeA, input.id));
      expectEqual(found?.status, 'stored', 'A’s file is untouched');
    },
  },
];
