import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type {
  ByteStream,
  FileStorage,
  StoredObject,
} from '@hk/core/files/application';
import { FILE_ERRORS } from '@hk/core/files/domain';
import { DomainError } from '@hk/platform/universal';

/**
 * File storage on any service that speaks the S3 API: Amazon S3, Cloudflare
 * R2, MinIO, a provider's object storage.
 *
 * Uploads are streamed. A file larger than one part is sent as a multipart
 * upload, a part at a time, so memory use does not grow with the file. If the
 * source stream fails, the multipart upload is aborted and the key keeps
 * whatever it held before.
 */

export interface S3ClientConfig {
  /** Leave out for Amazon S3. Set for every other S3-compatible service. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Address buckets as endpoint/bucket and not bucket.endpoint. Needed by
   * most S3-compatible services that are not Amazon. Defaults to true when an
   * endpoint is given.
   */
  forcePathStyle?: boolean;
  /**
   * When the SDK adds its own integrity checksums to requests.
   *
   * "when_supported" is the SDK's default and right for Amazon S3.
   * "when_required" sends them only where the API demands one. Several
   * S3-compatible services reject or mishandle the default, most visibly on
   * multipart uploads, so this is the default when an endpoint is given.
   */
  checksums?: 'when_supported' | 'when_required';
}

export const createS3Client = (config: S3ClientConfig): S3Client => {
  const checksums =
    config.checksums ??
    (config.endpoint === undefined ? 'when_supported' : 'when_required');
  const mode =
    checksums === 'when_supported' ? 'WHEN_SUPPORTED' : 'WHEN_REQUIRED';
  return new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle ?? config.endpoint !== undefined,
    requestChecksumCalculation: mode,
    responseChecksumValidation: mode,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
};

export interface S3FileStorageOptions {
  client: S3Client;
  bucket: string;
  /** Bytes per part of a multipart upload. At least 5 MB, the S3 minimum. Defaults to 5 MB. */
  partSize?: number;
}

const MIN_PART_SIZE = 5 * 1024 * 1024;

const objectNotFound = (): DomainError =>
  new DomainError(FILE_ERRORS.OBJECT_NOT_FOUND, 'The file is not in storage.', {
    kind: 'not-found',
  });

/** Whether an SDK error means "there is nothing under that key". */
const isMissing = (error: unknown): boolean => {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.name === 'NoSuchKey' ||
    candidate?.name === 'NotFound' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
};

export class S3FileStorage implements FileStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly partSize: number;

  constructor(options: S3FileStorageOptions) {
    const partSize = options.partSize ?? MIN_PART_SIZE;
    if (!Number.isInteger(partSize) || partSize < MIN_PART_SIZE) {
      throw new Error('S3 part size must be a whole number of at least 5 MB.');
    }
    if (options.bucket.trim().length === 0) {
      throw new Error('S3 bucket name is required.');
    }
    this.client = options.client;
    this.bucket = options.bucket;
    this.partSize = partSize;
  }

  async put(
    key: string,
    body: ByteStream,
    options: { contentType: string },
  ): Promise<{ size: number }> {
    let size = 0;
    // The SDK wraps a stream's failure in its own error. The caller needs
    // the original, so it is kept here as it passes.
    let sourceError: { error: unknown } | undefined;
    const source = body[Symbol.asyncIterator]();
    const counted: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          try {
            const next = await source.next();
            if (!next.done) size += next.value.length;
            return next;
          } catch (error) {
            sourceError = { error };
            throw error;
          }
        },
        return: async () => {
          await source.return?.();
          return { done: true, value: undefined };
        },
      }),
    };

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: Readable.from(counted, { objectMode: false }),
        ContentType: options.contentType,
      },
      partSize: this.partSize,
      // One part in flight at a time: memory stays at about one part.
      queueSize: 1,
      // Abort a failed multipart upload, so no parts are left to pay for.
      leavePartsOnError: false,
    });

    try {
      await upload.done();
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw sourceError ? sourceError.error : error;
    }
    return { size };
  }

  async get(key: string): Promise<StoredObject> {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (isMissing(error)) throw objectNotFound();
      throw error;
    }
    const stream = response.Body as Readable | undefined;
    if (!stream) throw objectNotFound();
    return {
      body: toByteStream(stream),
      size: response.ContentLength ?? 0,
      contentType: response.ContentType ?? 'application/octet-stream',
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 answers success whether or not the key held anything.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

/** A Node stream as a ByteStream of plain Uint8Arrays. */
const toByteStream = (stream: Readable): ByteStream => ({
  [Symbol.asyncIterator]() {
    const iterator = stream[Symbol.asyncIterator]();
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const next = await iterator.next();
        if (next.done) return { done: true, value: undefined };
        const chunk = next.value as Buffer;
        // A view over the same memory, without Buffer's extra methods.
        return {
          done: false,
          value: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length),
        };
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        stream.destroy();
        return { done: true, value: undefined };
      },
    };
  },
});

/**
 * Creates the bucket if it is not there. For local development and tests;
 * in production the bucket is created by infrastructure code, with its
 * encryption and access rules.
 */
export const ensureBucket = async (
  client: S3Client,
  bucket: string,
): Promise<void> => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isMissing(error)) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
};
