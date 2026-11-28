import {
  FILE_ERRORS,
  type FileRecord,
  type FileScope,
} from '@hk/core/files/domain';
import { DomainError } from '@hk/platform/universal';
import type {
  ByteStream,
  CreateStreamHasher,
  FileRecords,
  FileStorage,
  NewFileRecord,
  StoredObject,
  UnitOfWork,
} from './ports';
import { collectBytes, streamOf } from './streams';

/** Object storage held in memory. For tests and local tools. */
export class InMemoryFileStorage implements FileStorage {
  private readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string }
  >();

  async put(
    key: string,
    body: ByteStream,
    options: { contentType: string },
  ): Promise<{ size: number }> {
    // The whole stream is read before anything is stored, so a stream that
    // fails part-way leaves nothing behind.
    const bytes = await collectBytes(body);
    this.objects.set(key, { bytes, contentType: options.contentType });
    return { size: bytes.length };
  }

  async get(key: string): Promise<StoredObject> {
    const object = this.objects.get(key);
    if (!object) {
      throw new DomainError(
        FILE_ERRORS.OBJECT_NOT_FOUND,
        'The file is not in storage.',
        { kind: 'not-found' },
      );
    }
    // Served in pieces, as a real store does.
    const chunks: Uint8Array[] = [];
    const pieceSize = 64 * 1024;
    for (let start = 0; start < object.bytes.length; start += pieceSize) {
      chunks.push(object.bytes.slice(start, start + pieceSize));
    }
    return {
      body: streamOf(...chunks),
      size: object.bytes.length,
      contentType: object.contentType,
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** FOR TESTS: every key currently stored. */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}

const notFound = (): DomainError =>
  new DomainError(FILE_ERRORS.NOT_FOUND, 'The file was not found.', {
    kind: 'not-found',
  });

/** File records held in memory. For tests and local tools. */
export class InMemoryFileRecords implements FileRecords {
  private readonly rows = new Map<string, FileRecord>();

  private own(scope: FileScope, id: string): FileRecord | undefined {
    const row = this.rows.get(id);
    return row &&
      row.tenantId === scope.tenantId &&
      row.businessId === scope.businessId
      ? row
      : undefined;
  }

  async create(scope: FileScope, record: NewFileRecord): Promise<FileRecord> {
    if (this.rows.has(record.id)) {
      throw new DomainError(
        'FILE_ID_TAKEN',
        'A file with that id already exists.',
        { kind: 'conflict' },
      );
    }
    const row: FileRecord = Object.freeze({
      ...record,
      tenantId: scope.tenantId,
      businessId: scope.businessId,
      status: 'pending',
      size: null,
      sha256: null,
    });
    this.rows.set(row.id, row);
    return row;
  }

  async find(scope: FileScope, id: string): Promise<FileRecord | null> {
    return this.own(scope, id) ?? null;
  }

  async markStored(
    scope: FileScope,
    id: string,
    stored: { size: number; sha256: string },
  ): Promise<FileRecord> {
    const row = this.own(scope, id);
    if (!row || row.status !== 'pending') throw notFound();
    const next: FileRecord = Object.freeze({
      ...row,
      status: 'stored',
      size: stored.size,
      sha256: stored.sha256,
    });
    this.rows.set(id, next);
    return next;
  }

  async markDeleted(scope: FileScope, id: string): Promise<FileRecord> {
    const row = this.own(scope, id);
    if (!row || row.status !== 'stored') throw notFound();
    const next: FileRecord = Object.freeze({ ...row, status: 'deleted' });
    this.rows.set(id, next);
    return next;
  }

  async discardPending(scope: FileScope, id: string): Promise<void> {
    const row = this.own(scope, id);
    if (row && row.status === 'pending') {
      this.rows.delete(id);
    }
  }

  /** FOR TESTS: every record held, whatever the business. */
  all(): FileRecord[] {
    return [...this.rows.values()];
  }
}

/** A unit of work that just runs the action. For in-memory adapters. */
export const inlineUnitOfWork: UnitOfWork = {
  run: (_scope, action) => action(),
};

/**
 * A stand-in for SHA-256, FOR TESTS ONLY. Pure code cannot import a real
 * one. It is deterministic and gives 64 hex characters; it is NOT secure.
 * Production is given a real hasher, such as createNodeSha256 from
 * @hk/core/files/infra-s3.
 */
export const createInsecureTestHasher: CreateStreamHasher = () => {
  const state = [1, 2, 3, 4, 5, 6, 7, 8].map(
    (seed) => (0x811c9dc5 ^ Math.imul(seed, 0x9e3779b1)) >>> 0,
  );
  return {
    update: (chunk) => {
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index] ?? 0;
        for (let block = 0; block < state.length; block += 1) {
          state[block] =
            Math.imul((state[block] ?? 0) ^ byte, 0x01000193) >>> 0;
        }
      }
    },
    digest: () =>
      state.map((value) => value.toString(16).padStart(8, '0')).join(''),
  };
};
