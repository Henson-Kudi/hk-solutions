import type {
  ContentType,
  FilePurpose,
  FileRecord,
  FileScope,
} from '@hk/core/files/domain';

/**
 * A file's bytes, a piece at a time. Every runtime can produce and consume
 * one: a Node stream, a browser stream and a plain generator are all
 * AsyncIterable. A large file is never held in memory whole.
 */
export type ByteStream = AsyncIterable<Uint8Array>;

export interface StoredObject {
  body: ByteStream;
  /** Size in bytes. */
  size: number;
  contentType: string;
}

/**
 * Where the bytes are kept: an S3-compatible service in production, memory
 * in tests. Every implementation passes fileStorageConformance.
 *
 * Keys come from objectKeyFor. The storage does not know about tenants; the
 * key carries the business, and the use cases check it.
 */
export interface FileStorage {
  /**
   * Stores the stream under the key, replacing anything already there, and
   * returns how many bytes were stored. If the stream fails part-way, put
   * rejects with that error and nothing is stored under the key.
   */
  put(
    key: string,
    body: ByteStream,
    options: { contentType: string },
  ): Promise<{ size: number }>;
  /** Rejects with FILE_OBJECT_NOT_FOUND when there is nothing under the key. */
  get(key: string): Promise<StoredObject>;
  exists(key: string): Promise<boolean>;
  /** Removes the object. Removing one that is not there is not an error. */
  delete(key: string): Promise<void>;
}

export interface NewFileRecord {
  id: string;
  purpose: FilePurpose;
  name: string;
  contentType: ContentType;
  objectKey: string;
  createdAt: string;
  createdBy: string | null;
}

/**
 * What is known about each file: a table in production. Every implementation
 * passes fileRecordsConformance. Calls run inside UnitOfWork.run.
 */
export interface FileRecords {
  /** Adds a record in status "pending". */
  create(scope: FileScope, record: NewFileRecord): Promise<FileRecord>;
  /** The business's record, whatever its status, or null. */
  find(scope: FileScope, id: string): Promise<FileRecord | null>;
  /** pending -> stored. Rejects with FILE_NOT_FOUND for anything else. */
  markStored(
    scope: FileScope,
    id: string,
    stored: { size: number; sha256: string },
  ): Promise<FileRecord>;
  /** stored -> deleted. Rejects with FILE_NOT_FOUND for anything else. */
  markDeleted(scope: FileScope, id: string): Promise<FileRecord>;
  /** Removes a pending record whose upload failed. Does nothing otherwise. */
  discardPending(scope: FileScope, id: string): Promise<void>;
}

/**
 * Runs record calls as one unit for a business. On the server it is a tenant
 * transaction; in memory it just calls `action`. A storage call is never
 * made inside one: a transaction must not wait on a remote service.
 */
export interface UnitOfWork {
  run<T>(scope: FileScope, action: () => Promise<T>): Promise<T>;
}

/** SHA-256 fed a piece at a time. */
export interface StreamHasher {
  update(chunk: Uint8Array): void;
  /** 64 lower-case hex characters. */
  digest(): string;
}

export type CreateStreamHasher = () => StreamHasher;
