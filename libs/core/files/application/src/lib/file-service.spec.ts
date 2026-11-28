import {
  FILE_ERRORS,
  objectKeyFor,
  type FileScope,
} from '@hk/core/files/domain';
import { sequentialIds } from '@hk/platform/test-kit';
import { FixedClock, isDomainError } from '@hk/platform/universal';
import {
  fileRecordsConformance,
  fileStorageConformance,
  type FileRecordsSubject,
  type FileStorageSubject,
} from './conformance';
import {
  FILE_USE_CASES,
  createFileService,
  type FileService,
  type UploadInput,
} from './file-service';
import {
  InMemoryFileRecords,
  InMemoryFileStorage,
  createInsecureTestHasher,
  inlineUnitOfWork,
} from './in-memory';
import type { ByteStream, FileRecords, FileStorage } from './ports';
import { collectBytes, concatBytes, streamOf } from './streams';

const scopeA: FileScope = {
  tenantId: '018f0000-0000-7000-8000-00000000000a',
  businessId: '018f0000-0000-7000-8000-00000000000b',
};
const scopeB: FileScope = {
  tenantId: scopeA.tenantId,
  businessId: '018f0000-0000-7000-8000-00000000000c',
};
const userId = '018f0000-0000-7000-8000-0000000000aa';

const ascii = (text: string): Uint8Array =>
  Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));

/** A PDF of exactly `length` bytes: the signature, then filler. */
const pdfOf = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length).fill(0x20);
  bytes.set(ascii('%PDF-1.7\n'));
  return bytes;
};

const inChunks = (bytes: Uint8Array, size: number): ByteStream => {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push(bytes.subarray(start, start + size));
  }
  return streamOf(...chunks);
};

const hashOf = (bytes: Uint8Array): string => {
  const hasher = createInsecureTestHasher();
  hasher.update(bytes);
  return hasher.digest();
};

const codeOfRejection = async (
  action: () => Promise<unknown>,
): Promise<string> => {
  try {
    await action();
  } catch (error) {
    return isDomainError(error)
      ? error.code
      : `not a DomainError: ${String(error)}`;
  }
  return 'nothing was thrown';
};

describe('file service', () => {
  let storage: InMemoryFileStorage;
  let records: InMemoryFileRecords;
  let files: FileService;

  const build = (
    overrides: { storage?: FileStorage; records?: FileRecords } = {},
  ) =>
    createFileService({
      storage: overrides.storage ?? storage,
      records: overrides.records ?? records,
      unitOfWork: inlineUnitOfWork,
      createHasher: createInsecureTestHasher,
      clock: new FixedClock('2026-11-28T09:00:00.000Z'),
      newId: sequentialIds(7),
    });

  beforeEach(() => {
    storage = new InMemoryFileStorage();
    records = new InMemoryFileRecords();
    files = build();
  });

  const upload = (overrides: Partial<UploadInput> = {}, scope = scopeA) =>
    files.upload(scope, {
      purpose: 'attachment',
      name: 'invoice.pdf',
      declaredType: 'application/pdf',
      body: streamOf(pdfOf(2000)),
      createdBy: userId,
      ...overrides,
    });

  it('declares that no file use case runs offline', () => {
    expect(FILE_USE_CASES).toEqual({
      upload: { name: 'core.files.upload', offline: false },
      open: { name: 'core.files.open', offline: false },
      remove: { name: 'core.files.remove', offline: false },
    });
  });

  describe('upload', () => {
    it('stores the bytes and returns the record', async () => {
      const bytes = pdfOf(2000);
      const record = await upload({ body: inChunks(bytes, 300) });
      const id = '00000007-0000-7000-8000-000000000001';
      expect(record).toEqual({
        ...scopeA,
        id,
        purpose: 'attachment',
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        status: 'stored',
        size: 2000,
        sha256: hashOf(bytes),
        objectKey: objectKeyFor(scopeA, id),
        createdAt: '2026-11-28T09:00:00.000Z',
        createdBy: userId,
      });
      const object = await storage.get(record.objectKey);
      expect(object.contentType).toBe('application/pdf');
      expect(await collectBytes(object.body)).toEqual(bytes);
    });

    it('gives the same hash however the bytes are cut up', async () => {
      const bytes = pdfOf(5000);
      const whole = await upload({ body: streamOf(bytes) });
      const pieces = await upload({ body: inChunks(bytes, 7) });
      const uneven = await upload({
        body: streamOf(
          bytes.subarray(0, 3),
          new Uint8Array(0),
          bytes.subarray(3, 4000),
          bytes.subarray(4000),
        ),
      });
      expect(pieces.sha256).toBe(whole.sha256);
      expect(uneven.sha256).toBe(whole.sha256);
      expect([whole.size, pieces.size, uneven.size]).toEqual([
        5000, 5000, 5000,
      ]);
    });

    it('recognises the type even when the signature arrives one byte at a time', async () => {
      const record = await upload({ body: inChunks(pdfOf(600), 1) });
      expect(record.status).toBe('stored');
      expect(record.size).toBe(600);
    });

    it('cleans the name and puts the real type’s extension on it', async () => {
      const record = await upload({ name: '../../secret/Report Final.exe' });
      expect(record.name).toBe('Report Final.pdf');
    });

    it('never uses the name in the storage key', async () => {
      const record = await upload({ name: '../../../other-business/x.pdf' });
      expect(record.objectKey).toBe(objectKeyFor(scopeA, record.id));
      expect(record.objectKey).not.toContain('other-business');
      expect(storage.keys()).toEqual([record.objectKey]);
    });

    it('defaults the creator to nobody', async () => {
      const record = await upload({ createdBy: undefined });
      expect(record.createdBy).toBeNull();
    });

    it.each<[string, Partial<UploadInput>, string]>([
      [
        'a program claiming to be a PDF',
        {
          body: streamOf(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])),
        },
        FILE_ERRORS.TYPE_MISMATCH,
      ],
      [
        'a web page claiming to be a PDF',
        { body: streamOf(ascii('<html><script>x</script></html>')) },
        FILE_ERRORS.TYPE_MISMATCH,
      ],
      [
        'a type the purpose does not accept',
        { purpose: 'image' },
        FILE_ERRORS.TYPE_NOT_ALLOWED,
      ],
      [
        'a type nobody accepts',
        { declaredType: 'text/html', body: streamOf(ascii('<html>')) },
        FILE_ERRORS.TYPE_NOT_ALLOWED,
      ],
      [
        'an unknown purpose',
        { purpose: 'avatar' },
        FILE_ERRORS.PURPOSE_UNKNOWN,
      ],
      ['an empty file', { body: streamOf() }, FILE_ERRORS.EMPTY],
      [
        'a file of empty pieces only',
        { body: streamOf(new Uint8Array(0), new Uint8Array(0)) },
        FILE_ERRORS.EMPTY,
      ],
    ])('refuses %s, and stores nothing', async (_name, overrides, code) => {
      expect(await codeOfRejection(() => upload(overrides))).toBe(code);
      expect(storage.keys()).toEqual([]);
      expect(records.all()).toEqual([]);
    });

    it('accepts a file of exactly the size limit', async () => {
      const limit = 5 * 1024 * 1024;
      const png = new Uint8Array(limit);
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const record = await upload({
        purpose: 'image',
        declaredType: 'image/png',
        name: 'logo.png',
        body: inChunks(png, 256 * 1024),
      });
      expect(record.size).toBe(limit);
    });

    it('refuses a file one byte over the limit, and leaves nothing behind', async () => {
      const limit = 5 * 1024 * 1024;
      const png = new Uint8Array(limit + 1);
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(
        await codeOfRejection(() =>
          upload({
            purpose: 'image',
            declaredType: 'image/png',
            body: inChunks(png, 256 * 1024),
          }),
        ),
      ).toBe(FILE_ERRORS.TOO_LARGE);
      expect(storage.keys()).toEqual([]);
      expect(records.all()).toEqual([]);
    });

    it('stops reading an oversized upload as soon as it passes the limit', async () => {
      const piece = new Uint8Array(1024 * 1024).fill(0x20);
      const first = pdfOf(1024 * 1024);
      let served = 0;
      // An endless stream: reading it to the end would never finish.
      const endless: ByteStream = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            served += 1;
            return { done: false, value: served === 1 ? first : piece };
          },
        }),
      };
      expect(await codeOfRejection(() => upload({ body: endless }))).toBe(
        FILE_ERRORS.TOO_LARGE,
      );
      // The limit for an attachment is 10 MB: 11 pieces of 1 MB pass it.
      expect(served).toBe(11);
    });

    it('closes the source stream when it stops early', async () => {
      let closed = false;
      const source: ByteStream = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: ascii('<html>') }),
          return: async () => {
            closed = true;
            return { done: true, value: undefined };
          },
        }),
      };
      await codeOfRejection(() => upload({ body: source }));
      expect(closed).toBe(true);
    });

    it('passes on the error when the source stream fails, and leaves nothing behind', async () => {
      const failure = new Error('connection reset');
      let served = 0;
      const source: ByteStream = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            served += 1;
            if (served > 2) throw failure;
            return { done: false, value: pdfOf(400) };
          },
        }),
      };
      await expect(upload({ body: source })).rejects.toBe(failure);
      expect(storage.keys()).toEqual([]);
      expect(records.all()).toEqual([]);
    });

    it('leaves no record when storage refuses the upload', async () => {
      const failure = new Error('storage is down');
      const failing: FileStorage = {
        put: async () => {
          throw failure;
        },
        get: (key) => storage.get(key),
        exists: (key) => storage.exists(key),
        delete: (key) => storage.delete(key),
      };
      files = build({ storage: failing });
      await expect(upload()).rejects.toBe(failure);
      expect(records.all()).toEqual([]);
    });

    it('still reports the upload’s failure when the clean-up fails too', async () => {
      const failure = new Error('storage is down');
      const failing: FileStorage = {
        put: async () => {
          throw failure;
        },
        get: (key) => storage.get(key),
        exists: (key) => storage.exists(key),
        delete: async () => {
          throw new Error('delete failed as well');
        },
      };
      files = build({ storage: failing });
      await expect(upload()).rejects.toBe(failure);
      expect(records.all()).toEqual([]);
    });

    it('keeps two uploads of the same file apart', async () => {
      const first = await upload();
      const second = await upload();
      expect(second.id).not.toBe(first.id);
      expect(second.objectKey).not.toBe(first.objectKey);
      expect(second.sha256).toBe(first.sha256);
      expect(storage.keys()).toHaveLength(2);
    });
  });

  describe('open', () => {
    it('returns the record and the bytes', async () => {
      const bytes = pdfOf(300_000);
      const uploaded = await upload({ body: inChunks(bytes, 4096) });
      const opened = await files.open(scopeA, uploaded.id);
      expect(opened.record).toEqual(uploaded);
      expect(await collectBytes(opened.body)).toEqual(bytes);
    });

    it('serves the bytes in pieces, not all at once', async () => {
      const uploaded = await upload({ body: streamOf(pdfOf(300_000)) });
      const opened = await files.open(scopeA, uploaded.id);
      const iterator = opened.body[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value?.length).toBeLessThan(300_000);
    });

    it('does not find another business’s file', async () => {
      const uploaded = await upload();
      expect(await codeOfRejection(() => files.open(scopeB, uploaded.id))).toBe(
        FILE_ERRORS.NOT_FOUND,
      );
      expect(
        await codeOfRejection(() => files.describe(scopeB, uploaded.id)),
      ).toBe(FILE_ERRORS.NOT_FOUND);
    });

    it('does not find an id that does not exist', async () => {
      expect(
        await codeOfRejection(() =>
          files.open(scopeA, '018f0000-0000-7000-8000-000000000404'),
        ),
      ).toBe(FILE_ERRORS.NOT_FOUND);
    });

    it('does not open a file that is still being uploaded', async () => {
      await records.create(scopeA, {
        id: '018f0000-0000-7000-8000-0000000000f1',
        purpose: 'attachment',
        name: 'x.pdf',
        contentType: 'application/pdf',
        objectKey: objectKeyFor(scopeA, '018f0000-0000-7000-8000-0000000000f1'),
        createdAt: '2026-11-28T09:00:00.000Z',
        createdBy: null,
      });
      expect(
        await codeOfRejection(() =>
          files.open(scopeA, '018f0000-0000-7000-8000-0000000000f1'),
        ),
      ).toBe(FILE_ERRORS.NOT_FOUND);
    });

    it('refuses a record whose key points into another business', async () => {
      const id = '018f0000-0000-7000-8000-0000000000f2';
      await records.create(scopeA, {
        id,
        purpose: 'attachment',
        name: 'x.pdf',
        contentType: 'application/pdf',
        // A record that should never exist: A's record, B's object.
        objectKey: objectKeyFor(scopeB, id),
        createdAt: '2026-11-28T09:00:00.000Z',
        createdBy: null,
      });
      await records.markStored(scopeA, id, {
        size: 1,
        sha256: 'ab'.repeat(32),
      });
      expect(await codeOfRejection(() => files.open(scopeA, id))).toBe(
        FILE_ERRORS.NOT_FOUND,
      );
      expect(await codeOfRejection(() => files.remove(scopeA, id))).toBe(
        FILE_ERRORS.NOT_FOUND,
      );
    });

    it('says the object is missing when the record is there but the bytes are not', async () => {
      const uploaded = await upload();
      await storage.delete(uploaded.objectKey);
      expect(await codeOfRejection(() => files.open(scopeA, uploaded.id))).toBe(
        FILE_ERRORS.OBJECT_NOT_FOUND,
      );
    });
  });

  describe('remove', () => {
    it('removes the bytes and keeps the record, marked deleted', async () => {
      const uploaded = await upload();
      const removed = await files.remove(scopeA, uploaded.id);
      expect(removed).toEqual({ ...uploaded, status: 'deleted' });
      expect(storage.keys()).toEqual([]);
      expect(await records.find(scopeA, uploaded.id)).toEqual(removed);
    });

    it('makes the file not found afterwards, and cannot be done twice', async () => {
      const uploaded = await upload();
      await files.remove(scopeA, uploaded.id);
      expect(await codeOfRejection(() => files.open(scopeA, uploaded.id))).toBe(
        FILE_ERRORS.NOT_FOUND,
      );
      expect(
        await codeOfRejection(() => files.remove(scopeA, uploaded.id)),
      ).toBe(FILE_ERRORS.NOT_FOUND);
    });

    it('does not remove another business’s file', async () => {
      const uploaded = await upload();
      expect(
        await codeOfRejection(() => files.remove(scopeB, uploaded.id)),
      ).toBe(FILE_ERRORS.NOT_FOUND);
      expect(storage.keys()).toEqual([uploaded.objectKey]);
      expect((await files.describe(scopeA, uploaded.id)).status).toBe('stored');
    });

    it('marks the record deleted even when removing the bytes fails', async () => {
      const uploaded = await upload();
      const failure = new Error('storage is down');
      files = build({
        storage: {
          put: (key, body, options) => storage.put(key, body, options),
          get: (key) => storage.get(key),
          exists: (key) => storage.exists(key),
          delete: async () => {
            throw failure;
          },
        },
      });
      await expect(files.remove(scopeA, uploaded.id)).rejects.toBe(failure);
      // The file is gone as far as anyone can tell; the bytes are left for a sweep.
      expect((await records.find(scopeA, uploaded.id))?.status).toBe('deleted');
      expect(await codeOfRejection(() => files.open(scopeA, uploaded.id))).toBe(
        FILE_ERRORS.NOT_FOUND,
      );
    });
  });
});

describe('stream helpers', () => {
  it('collects a stream into one array', async () => {
    expect(
      await collectBytes(
        streamOf(
          Uint8Array.from([1, 2]),
          new Uint8Array(0),
          Uint8Array.from([3]),
        ),
      ),
    ).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await collectBytes(streamOf())).toEqual(new Uint8Array(0));
  });

  it('lets a stream be read more than once', async () => {
    const stream = streamOf(Uint8Array.from([1, 2, 3]));
    expect(await collectBytes(stream)).toEqual(await collectBytes(stream));
  });

  it('joins chunks', () => {
    expect(
      concatBytes([Uint8Array.from([1]), Uint8Array.from([2, 3])]),
    ).toEqual(Uint8Array.from([1, 2, 3]));
  });
});

describe('the test hasher', () => {
  it('is deterministic, 64 hex characters, and sensitive to every byte', () => {
    const a = hashOf(Uint8Array.from([1, 2, 3]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(Uint8Array.from([1, 2, 3]))).toBe(a);
    expect(hashOf(Uint8Array.from([1, 2, 4]))).not.toBe(a);
    expect(hashOf(Uint8Array.from([1, 2, 3, 0]))).not.toBe(a);
  });
});

describe('InMemoryFileStorage conformance', () => {
  const subject = (): FileStorageSubject => {
    const keys = sequentialIds(3);
    return {
      storage: new InMemoryFileStorage(),
      newKey: () => objectKeyFor(scopeA, keys()),
    };
  };
  for (const testCase of fileStorageConformance) {
    it(testCase.name, () => testCase.run(subject()));
  }
});

describe('InMemoryFileRecords conformance', () => {
  const subject = (): FileRecordsSubject => ({
    records: new InMemoryFileRecords(),
    scopeA,
    scopeB,
    within: (_scope, action) => action(),
  });
  for (const testCase of fileRecordsConformance) {
    it(testCase.name, () => testCase.run(subject()));
  }
});

describe('the storage conformance suite notices a store that', () => {
  const run = async (
    wrap: (inner: InMemoryFileStorage) => Partial<FileStorage>,
  ): Promise<string[]> => {
    const failed: string[] = [];
    for (const testCase of fileStorageConformance) {
      const inner = new InMemoryFileStorage();
      const overrides = wrap(inner);
      const keys = sequentialIds(4);
      const storage: FileStorage = {
        put:
          overrides.put ??
          ((key, body, options) => inner.put(key, body, options)),
        get: overrides.get ?? ((key) => inner.get(key)),
        exists: overrides.exists ?? ((key) => inner.exists(key)),
        delete: overrides.delete ?? ((key) => inner.delete(key)),
      };
      try {
        await testCase.run({
          storage,
          newKey: () => objectKeyFor(scopeA, keys()),
        });
      } catch {
        failed.push(testCase.name);
      }
    }
    return failed;
  };

  it('is sound: a store with nothing replaced fails nothing', async () => {
    expect(await run(() => ({}))).toEqual([]);
  });

  it('keeps part of a file whose stream failed', async () => {
    const failed = await run((inner) => ({
      put: async (key, body, options) => {
        const iterator = body[Symbol.asyncIterator]();
        const got: Uint8Array[] = [];
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            got.push(next.value);
          }
        } finally {
          // Stores whatever arrived, complete or not.
          await inner.put(key, streamOf(...got), options);
        }
        return { size: got.reduce((sum, chunk) => sum + chunk.length, 0) };
      },
    }));
    expect(failed).toEqual([
      'when the stream fails part-way, put rejects with that error and stores nothing',
      'a failed put leaves what the key held before',
    ]);
  });

  it('truncates large files', async () => {
    const failed = await run((inner) => ({
      put: async (key, body, options) => {
        const bytes = await collectBytes(body);
        return inner.put(
          key,
          streamOf(bytes.subarray(0, 5 * 1024 * 1024)),
          options,
        );
      },
    }));
    expect(failed).toEqual([
      'a large file arriving in small pieces is stored whole',
    ]);
  });

  it('loses the content type', async () => {
    const failed = await run((inner) => ({
      put: (key, body) =>
        inner.put(key, body, { contentType: 'application/octet-stream' }),
    }));
    expect(failed).toContain('what is put can be read back, byte for byte');
    expect(failed).toContain('put replaces what a key held');
  });

  it('answers a missing key with an empty file', async () => {
    const failed = await run((inner) => ({
      get: async (key) =>
        (await inner.exists(key))
          ? inner.get(key)
          : { body: streamOf(), size: 0, contentType: 'text/plain' },
    }));
    expect(failed).toEqual([
      'reading a key that holds nothing is FILE_OBJECT_NOT_FOUND',
      'delete removes the object, and deleting again is not an error',
    ]);
  });

  it('fails when asked to delete what is not there', async () => {
    const failed = await run((inner) => ({
      delete: async (key) => {
        if (!(await inner.exists(key))) throw new Error('no such key');
        await inner.delete(key);
      },
    }));
    expect(failed).toEqual([
      'delete removes the object, and deleting again is not an error',
    ]);
  });

  it('does not really delete', async () => {
    const failed = await run(() => ({ delete: async () => undefined }));
    expect(failed).toContain(
      'delete removes the object, and deleting again is not an error',
    );
  });

  it('corrupts a byte', async () => {
    const failed = await run((inner) => ({
      put: async (key, body, options) => {
        const bytes = await collectBytes(body);
        const copy = bytes.slice();
        if (copy.length > 200) copy[200] = (copy[200] ?? 0) ^ 0xff;
        return inner.put(key, streamOf(copy), options);
      },
    }));
    expect(failed).toContain('what is put can be read back, byte for byte');
    expect(failed).toContain('every byte value survives, including zero');
  });
});

describe('the records conformance suite notices a store that', () => {
  const run = async (
    wrap: (inner: InMemoryFileRecords) => Partial<FileRecords>,
  ): Promise<string[]> => {
    const failed: string[] = [];
    for (const testCase of fileRecordsConformance) {
      const inner = new InMemoryFileRecords();
      const overrides = wrap(inner);
      const recordsUnderTest: FileRecords = {
        create:
          overrides.create ?? ((scope, record) => inner.create(scope, record)),
        find: overrides.find ?? ((scope, id) => inner.find(scope, id)),
        markStored:
          overrides.markStored ??
          ((scope, id, stored) => inner.markStored(scope, id, stored)),
        markDeleted:
          overrides.markDeleted ??
          ((scope, id) => inner.markDeleted(scope, id)),
        discardPending:
          overrides.discardPending ??
          ((scope, id) => inner.discardPending(scope, id)),
      };
      try {
        await testCase.run({
          records: recordsUnderTest,
          scopeA,
          scopeB,
          within: (_scope, action) => action(),
        });
      } catch {
        failed.push(testCase.name);
      }
    }
    return failed;
  };

  it('is sound: a store with nothing replaced fails nothing', async () => {
    expect(await run(() => ({}))).toEqual([]);
  });

  it('ignores which business is asking', async () => {
    const failed = await run((inner) => ({
      find: (_scope, id) => inner.find(scopeA, id),
      markDeleted: (_scope, id) => inner.markDeleted(scopeA, id),
    }));
    expect(failed).toEqual([
      'one business cannot see or change another’s records',
    ]);
  });

  it('lets a file be marked stored twice', async () => {
    const failed = await run((inner) => ({
      markStored: async (scope, id, stored) => {
        const row = await inner.find(scope, id);
        if (row?.status === 'stored') return row;
        return inner.markStored(scope, id, stored);
      },
    }));
    expect(failed).toEqual([
      'markStored works once: not on a stored, deleted or unknown record',
    ]);
  });

  it('removes the record when a file is deleted', async () => {
    const failed = await run((inner) => ({
      markDeleted: async (scope, id) => {
        const deleted = await inner.markDeleted(scope, id);
        (inner as unknown as { rows: Map<string, unknown> }).rows.delete(id);
        return deleted;
      },
    }));
    expect(failed).toContain(
      'markDeleted moves a stored record to deleted, and keeps it',
    );
  });

  it('discards records that are not pending', async () => {
    const failed = await run((inner) => ({
      discardPending: async (_scope, id) => {
        (inner as unknown as { rows: Map<string, unknown> }).rows.delete(id);
      },
    }));
    expect(failed).toEqual([
      'discardPending removes a pending record and nothing else',
      'one business cannot see or change another’s records',
    ]);
  });

  it('forgets the size and hash', async () => {
    const failed = await run((inner) => ({
      find: async (scope, id) => {
        const row = await inner.find(scope, id);
        return row ? { ...row, size: null, sha256: null } : null;
      },
    }));
    expect(failed).toContain(
      'markStored moves a pending record to stored, with its size and hash',
    );
  });
});
