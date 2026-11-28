import {
  FILE_ERRORS,
  SNIFF_LENGTH,
  checkUpload,
  isObjectKeyOf,
  objectKeyFor,
  policyFor,
  safeFileName,
  tooLarge,
  type FilePurpose,
  type FileRecord,
  type FileScope,
} from '@hk/core/files/domain';
import { DomainError, type Clock } from '@hk/platform/universal';
import type {
  ByteStream,
  CreateStreamHasher,
  FileRecords,
  FileStorage,
  UnitOfWork,
} from './ports';
import { concatBytes } from './streams';

/**
 * The file use cases: upload, open, remove.
 *
 * None runs offline. A device keeps a picture it took until it can upload
 * it; the upload itself needs the server.
 */
export const FILE_USE_CASES = {
  upload: { name: 'core.files.upload', offline: false },
  open: { name: 'core.files.open', offline: false },
  remove: { name: 'core.files.remove', offline: false },
} as const;

export interface UploadInput {
  /** Why the file is stored. Decides which types and sizes are accepted. */
  purpose: string;
  /** The name on the uploader's machine. It is cleaned before use. */
  name: string;
  /** The content type the uploader claims. It is checked against the bytes. */
  declaredType: string;
  body: ByteStream;
  createdBy?: string | null;
}

export interface OpenedFile {
  record: FileRecord;
  body: ByteStream;
}

export interface FileServiceOptions {
  storage: FileStorage;
  records: FileRecords;
  unitOfWork: UnitOfWork;
  createHasher: CreateStreamHasher;
  clock: Clock;
  /** Makes file ids. A UUID v7 generator in production. */
  newId: () => string;
}

export interface FileService {
  /**
   * Checks and stores a file, and returns its record.
   *
   * The type is decided from the first bytes, not from the name or the
   * claimed type. The size limit is enforced while the bytes pass through,
   * so an oversized upload is stopped without being read to the end. If
   * anything fails, no object and no record are left behind.
   */
  upload(scope: FileScope, input: UploadInput): Promise<FileRecord>;
  /** The record and the bytes of a stored file. FILE_NOT_FOUND otherwise. */
  open(scope: FileScope, id: string): Promise<OpenedFile>;
  /** The record of a stored file, without opening the bytes. */
  describe(scope: FileScope, id: string): Promise<FileRecord>;
  /** Removes a stored file. Its record stays, marked deleted. */
  remove(scope: FileScope, id: string): Promise<FileRecord>;
}

const notFound = (): DomainError =>
  new DomainError(FILE_ERRORS.NOT_FOUND, 'The file was not found.', {
    kind: 'not-found',
  });

export const createFileService = (options: FileServiceOptions): FileService => {
  const { storage, records, unitOfWork, createHasher, clock, newId } = options;

  const stored = async (scope: FileScope, id: string): Promise<FileRecord> => {
    const record = await unitOfWork.run(scope, () => records.find(scope, id));
    // A pending or deleted file is, to its users, not there. So is a record
    // whose key points outside its own business, which should never exist.
    if (
      !record ||
      record.status !== 'stored' ||
      !isObjectKeyOf(scope, record.objectKey)
    ) {
      throw notFound();
    }
    return record;
  };

  const upload = async (
    scope: FileScope,
    input: UploadInput,
  ): Promise<FileRecord> => {
    const source = input.body[Symbol.asyncIterator]();
    let sourceDone = false;
    const closeSource = async (): Promise<void> => {
      if (!sourceDone) {
        sourceDone = true;
        await source.return?.();
      }
    };

    try {
      // Read just enough to see what the file is.
      const buffered: Uint8Array[] = [];
      let bufferedLength = 0;
      while (bufferedLength < SNIFF_LENGTH) {
        const next = await source.next();
        if (next.done) {
          sourceDone = true;
          break;
        }
        if (next.value.length > 0) {
          buffered.push(next.value);
          bufferedLength += next.value.length;
        }
      }

      const checked = checkUpload({
        purpose: input.purpose,
        declaredType: input.declaredType,
        head: concatBytes(buffered),
      });
      if (!checked.ok) {
        throw checked.error;
      }
      const contentType = checked.value;
      const purpose = input.purpose as FilePurpose;
      const { maxBytes } = policyFor(purpose);

      const id = newId();
      const objectKey = objectKeyFor(scope, id);
      await unitOfWork.run(scope, () =>
        records.create(scope, {
          id,
          purpose,
          name: safeFileName(input.name, contentType),
          contentType,
          objectKey,
          createdAt: clock.now().toISOString(),
          createdBy: input.createdBy ?? null,
        }),
      );

      const hasher = createHasher();
      let size = 0;
      const pass = (chunk: Uint8Array): Uint8Array => {
        size += chunk.length;
        if (size > maxBytes) {
          throw tooLarge(purpose);
        }
        hasher.update(chunk);
        return chunk;
      };
      // The bytes already read, then the rest of the source. Written with
      // plain iterator calls (see streams.ts).
      let replayed = 0;
      const counted: ByteStream = {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            const held = buffered[replayed];
            if (held !== undefined) {
              replayed += 1;
              return { done: false, value: pass(held) };
            }
            while (!sourceDone) {
              const next = await source.next();
              if (next.done) {
                sourceDone = true;
                break;
              }
              if (next.value.length > 0) {
                return { done: false, value: pass(next.value) };
              }
            }
            return { done: true, value: undefined };
          },
        }),
      };

      try {
        await storage.put(objectKey, counted, { contentType });
      } catch (error) {
        // Leave nothing behind: no object, no record.
        await storage.delete(objectKey).catch(() => undefined);
        await unitOfWork.run(scope, () => records.discardPending(scope, id));
        throw error;
      }

      return await unitOfWork.run(scope, () =>
        records.markStored(scope, id, { size, sha256: hasher.digest() }),
      );
    } finally {
      await closeSource().catch(() => undefined);
    }
  };

  const open = async (scope: FileScope, id: string): Promise<OpenedFile> => {
    const record = await stored(scope, id);
    const object = await storage.get(record.objectKey);
    return { record, body: object.body };
  };

  const remove = async (scope: FileScope, id: string): Promise<FileRecord> => {
    const record = await stored(scope, id);
    // The record first: if removing the bytes then fails, the file is already
    // gone as far as anyone can tell, and the leftover bytes are swept later.
    const deleted = await unitOfWork.run(scope, () =>
      records.markDeleted(scope, id),
    );
    await storage.delete(record.objectKey);
    return deleted;
  };

  return { upload, open, describe: stored, remove };
};
