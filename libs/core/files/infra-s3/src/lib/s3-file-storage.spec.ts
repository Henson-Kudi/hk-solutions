import { createHash } from 'node:crypto';
import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  InMemoryFileRecords,
  collectBytes,
  createFileService,
  fileStorageConformance,
  inlineUnitOfWork,
  streamOf,
  type ByteStream,
  type FileService,
} from '@hk/core/files/application';
import {
  FILE_ERRORS,
  objectKeyFor,
  objectPrefixFor,
  type FileScope,
} from '@hk/core/files/domain';
import {
  acquireObjectStore,
  objectStoreAvailable,
  type StartedObjectStore,
} from '@hk/platform/testing';
import {
  createUuidV7Generator,
  isDomainError,
  systemClock,
} from '@hk/platform/universal';
import { createNodeSha256 } from './node-sha256';
import { S3FileStorage, createS3Client, ensureBucket } from './s3-file-storage';

/**
 * These need an S3-compatible server: the one at HK_TEST_S3_ENDPOINT
 * (`pnpm infra:up` locally), or a container when HK_TEST_CONTAINERS=1. CI
 * starts a container.
 */
const describeWithObjectStore = objectStoreAvailable()
  ? describe
  : describe.skip;

const scopeA: FileScope = {
  tenantId: '018f0000-0000-7000-8000-00000000000a',
  businessId: '018f0000-0000-7000-8000-00000000000b',
};
const MB = 1024 * 1024;

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A PDF of exactly `length` bytes: the signature, then a repeating pattern. */
const pdfOf = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31) & 0xff;
  }
  bytes.set(Buffer.from('%PDF-1.7\n', 'latin1'));
  return bytes;
};

const inChunks = (bytes: Uint8Array, size: number): ByteStream => {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push(bytes.subarray(start, start + size));
  }
  return streamOf(...chunks);
};

describe('test setup', () => {
  it('has an object store to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(objectStoreAvailable()).toBe(true);
    }
  });
});

describe('createNodeSha256', () => {
  // Published SHA-256 test vectors (FIPS 180-2).
  it('matches the published vectors', () => {
    const hashOf = (text: string) => {
      const hasher = createNodeSha256();
      hasher.update(Buffer.from(text, 'utf8'));
      return hasher.digest();
    };
    expect(hashOf('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const empty = createNodeSha256();
    expect(empty.digest()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('gives the same hash however the bytes are fed in', () => {
    const bytes = pdfOf(10_000);
    const whole = createNodeSha256();
    whole.update(bytes);
    const pieces = createNodeSha256();
    for (let start = 0; start < bytes.length; start += 7) {
      pieces.update(bytes.subarray(start, start + 7));
    }
    expect(pieces.digest()).toBe(whole.digest());
  });

  it('keeps separate files separate', () => {
    const first = createNodeSha256();
    const second = createNodeSha256();
    first.update(Uint8Array.from([1]));
    second.update(Uint8Array.from([2]));
    expect(first.digest()).not.toBe(second.digest());
  });
});

describe('S3FileStorage options', () => {
  const client = createS3Client({
    endpoint: 'http://127.0.0.1:1',
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'test',
  });

  it('refuses a part size below the S3 minimum', () => {
    expect(
      () => new S3FileStorage({ client, bucket: 'b', partSize: 1024 }),
    ).toThrow(/at least 5 MB/);
    expect(
      () => new S3FileStorage({ client, bucket: 'b', partSize: 5 * MB + 0.5 }),
    ).toThrow(/whole number/);
  });

  it('sends checksums only when required for a custom endpoint, and by default for Amazon S3', async () => {
    expect(await client.config.requestChecksumCalculation()).toBe(
      'WHEN_REQUIRED',
    );
    expect(await client.config.responseChecksumValidation()).toBe(
      'WHEN_REQUIRED',
    );
    const amazon = createS3Client({
      region: 'eu-north-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    expect(await amazon.config.requestChecksumCalculation()).toBe(
      'WHEN_SUPPORTED',
    );
    const forced = createS3Client({
      endpoint: 'http://127.0.0.1:1',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      checksums: 'when_supported',
    });
    expect(await forced.config.requestChecksumCalculation()).toBe(
      'WHEN_SUPPORTED',
    );
  });

  it('refuses an empty bucket name', () => {
    expect(() => new S3FileStorage({ client, bucket: ' ' })).toThrow(
      /bucket name is required/,
    );
  });

  it('uses path-style addresses when given an endpoint, and not for Amazon S3', async () => {
    expect(await client.config.forcePathStyle).toBe(true);
    const amazon = createS3Client({
      region: 'eu-north-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    expect(await amazon.config.forcePathStyle).toBe(false);
  });
});

describeWithObjectStore('S3FileStorage', () => {
  let store: StartedObjectStore;
  let client: S3Client;
  let storage: S3FileStorage;
  const bucket = `hk-spec-${Date.now().toString(36)}`;
  const newId = createUuidV7Generator();
  const newKey = () => objectKeyFor(scopeA, newId());

  const keysUnder = async (prefix: string): Promise<string[]> => {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
    );
    return (listed.Contents ?? []).map((object) => object.Key ?? '');
  };

  beforeAll(async () => {
    const acquired = await acquireObjectStore();
    if (!acquired) throw new Error('no object store available');
    store = acquired;
    client = createS3Client({
      endpoint: store.endpoint,
      region: store.region,
      accessKeyId: store.accessKeyId,
      secretAccessKey: store.secretAccessKey,
    });
    await ensureBucket(client, bucket);
    storage = new S3FileStorage({ client, bucket });
  }, 120_000);

  afterAll(async () => {
    client?.destroy();
    await store?.stop();
  });

  describe('conformance', () => {
    for (const testCase of fileStorageConformance) {
      it(testCase.name, () => testCase.run({ storage, newKey }), 60_000);
    }
  });

  it('creates a bucket once, and leaves an existing one alone', async () => {
    const key = newKey();
    await storage.put(key, streamOf(pdfOf(100)), {
      contentType: 'application/pdf',
    });
    await ensureBucket(client, bucket);
    expect(await storage.exists(key)).toBe(true);
  });

  it('sends a file larger than one part as a multipart upload, and reads it back', async () => {
    const key = newKey();
    const bytes = pdfOf(11 * MB + 17);
    const result = await storage.put(key, inChunks(bytes, 256 * 1024), {
      contentType: 'application/pdf',
    });
    expect(result.size).toBe(bytes.length);
    const object = await storage.get(key);
    expect(object.size).toBe(bytes.length);
    expect(sha256Of(await collectBytes(object.body))).toBe(sha256Of(bytes));
  }, 60_000);

  it('aborts a multipart upload whose stream fails, leaving no parts behind', async () => {
    const key = newKey();
    const failure = new Error('connection reset');
    let served = 0;
    const piece = pdfOf(MB);
    // Fails after 8 MB: one 5 MB part has already been sent.
    const failing: ByteStream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          served += 1;
          if (served > 8) throw failure;
          return { done: false, value: piece };
        },
      }),
    };
    await expect(
      storage.put(key, failing, { contentType: 'application/pdf' }),
    ).rejects.toBe(failure);
    expect(await storage.exists(key)).toBe(false);
    const pending = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket }),
    );
    expect(
      (pending.Uploads ?? []).filter((upload) => upload.Key === key),
    ).toEqual([]);
  }, 60_000);

  it('lets a reader stop early without reading the rest', async () => {
    const key = newKey();
    await storage.put(key, streamOf(pdfOf(2 * MB)), {
      contentType: 'application/pdf',
    });
    const object = await storage.get(key);
    const iterator = object.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeInstanceOf(Uint8Array);
    await iterator.return?.();
    // The storage still works after an abandoned read.
    expect(await storage.exists(key)).toBe(true);
  });

  it('reports a missing bucket as an error, not as a missing file', async () => {
    const elsewhere = new S3FileStorage({ client, bucket: `${bucket}-absent` });
    let caught: unknown;
    try {
      await elsewhere.put(newKey(), streamOf(pdfOf(10)), {
        contentType: 'application/pdf',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isDomainError(caught)).toBe(false);
  });

  describe('with the file service', () => {
    let records: InMemoryFileRecords;
    let files: FileService;

    beforeEach(() => {
      records = new InMemoryFileRecords();
      files = createFileService({
        storage,
        records,
        unitOfWork: inlineUnitOfWork,
        createHasher: createNodeSha256,
        clock: systemClock,
        newId: createUuidV7Generator(),
      });
    });

    it('uploads, opens and removes a file, with a real SHA-256', async () => {
      const bytes = pdfOf(7 * MB);
      const record = await files.upload(scopeA, {
        purpose: 'attachment',
        name: 'contract.pdf',
        declaredType: 'application/pdf',
        body: inChunks(bytes, 512 * 1024),
      });
      expect(record.status).toBe('stored');
      expect(record.size).toBe(bytes.length);
      expect(record.sha256).toBe(sha256Of(bytes));
      expect(record.objectKey.startsWith(objectPrefixFor(scopeA))).toBe(true);

      const opened = await files.open(scopeA, record.id);
      expect(sha256Of(await collectBytes(opened.body))).toBe(record.sha256);

      await files.remove(scopeA, record.id);
      expect(await storage.exists(record.objectKey)).toBe(false);
    }, 60_000);

    it('stops an oversized upload and leaves nothing in the bucket', async () => {
      const before = await keysUnder(objectPrefixFor(scopeA));
      const piece = pdfOf(MB);
      let served = 0;
      // An endless stream of 1 MB pieces.
      const endless: ByteStream = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            served += 1;
            return { done: false, value: piece };
          },
        }),
      };
      let code: string | undefined;
      try {
        await files.upload(scopeA, {
          purpose: 'attachment',
          name: 'huge.pdf',
          declaredType: 'application/pdf',
          body: endless,
        });
      } catch (error) {
        code = isDomainError(error) ? error.code : String(error);
      }
      expect(code).toBe(FILE_ERRORS.TOO_LARGE);
      // 10 MB limit: the eleventh piece passes it, and no more is read.
      expect(served).toBe(11);
      expect(await keysUnder(objectPrefixFor(scopeA))).toEqual(before);
      expect(records.all()).toEqual([]);
      const pending = await client.send(
        new ListMultipartUploadsCommand({ Bucket: bucket }),
      );
      expect(pending.Uploads ?? []).toEqual([]);
    }, 60_000);

    it('refuses a program disguised as a PDF before anything reaches the bucket', async () => {
      const before = await keysUnder(objectPrefixFor(scopeA));
      await expect(
        files.upload(scopeA, {
          purpose: 'attachment',
          name: 'invoice.pdf',
          declaredType: 'application/pdf',
          body: streamOf(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])),
        }),
      ).rejects.toMatchObject({ code: FILE_ERRORS.TYPE_MISMATCH });
      expect(await keysUnder(objectPrefixFor(scopeA))).toEqual(before);
    });
  });
});
