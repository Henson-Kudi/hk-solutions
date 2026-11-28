# core/files

Stored files: receipts, logos, imports, exports. The bytes live in an S3-compatible object store;
a table says what each file is and where it is.

| Lib                          | Runs on    | Holds                                                                       |
| ---------------------------- | ---------- | --------------------------------------------------------------------------- |
| `@hk/core/files/domain`      | anywhere   | Type sniffing, the upload policy, safe file names, the storage key layout   |
| `@hk/core/files/application` | anywhere   | The `FileStorage` and `FileRecords` ports, `createFileService`, conformance |
| `@hk/core/files/infra-pg`    | the server | The `files` table, `PgFileRecords`, the PostgreSQL unit of work             |
| `@hk/core/files/infra-s3`    | the server | `S3FileStorage`, `createS3Client`, a streaming SHA-256                      |

## Uploading

```ts
const record = await files.upload(scope, {
  purpose: 'attachment',
  name: file.originalName, // cleaned before use
  declaredType: file.mimeType, // checked against the bytes
  body: file.stream, // any AsyncIterable<Uint8Array>
  createdBy: userId,
});
```

What `upload` does, in order:

1. Reads the first 512 bytes and works out what the file **really** is.
2. Refuses it unless the purpose accepts the declared type and the bytes match it.
3. Creates a `pending` record.
4. Streams the bytes to storage, counting and hashing them as they pass. The moment the size limit
   is passed the upload stops; the rest is never read.
5. Marks the record `stored`, with its size and SHA-256.

If anything fails, no object and no record are left behind.

## What is accepted

| Purpose      | Types                            | Limit |
| ------------ | -------------------------------- | ----- |
| `attachment` | PDF, PNG, JPEG, WebP, DOCX, XLSX | 10 MB |
| `image`      | PNG, JPEG, WebP, GIF             | 5 MB  |
| `import`     | CSV, plain text, XLSX            | 20 MB |
| `export`     | PDF, CSV, plain text, XLSX, ZIP  | 50 MB |

- **The type comes from the bytes, not the name.** A program named `invoice.pdf` is refused.
- **HTML, SVG and XML are never accepted**, under any name: a browser would run scripts in them.
- **The file name is cleaned**: only the last path segment, no control characters, and the
  extension of the real type. `../../Report.exe` holding a PDF becomes `Report.pdf`.
- **The storage key is built from ids only**: `tenants/<id>/businesses/<id>/files/<id>`. Nothing a
  user typed is in it, so no name can steer a file into another business's folder.

This is not a virus scan. It stops a file being stored under a false type.

## Reading and removing

```ts
const { record, body } = await files.open(scope, id); // body is a stream
await files.remove(scope, id); // record stays, marked deleted
```

A file that is pending, deleted, or another business's is simply not found.

## Storage services

`S3FileStorage` works with any service that speaks the S3 API. For anything other than Amazon S3,
pass an `endpoint`:

```ts
const client = createS3Client({ endpoint, region, accessKeyId, secretAccessKey });
const storage = new S3FileStorage({ client, bucket });
```

With an endpoint, the client uses path-style addresses and sends integrity checksums only where
the API requires them. The SDK's default of always sending them breaks multipart uploads on
several S3-compatible services.

## Testing

Locally, `pnpm infra:up` starts an S3-compatible test server on `127.0.0.1:9090`; run tests with
`HK_TEST_S3_ENDPOINT=http://127.0.0.1:9090`. In CI the tests start their own container.

A new storage or records adapter runs `fileStorageConformance` or `fileRecordsConformance`.

## Review

`infra-pg/src/lib/schema.ts` becomes a migration. It needs Henson's line-by-line review.
