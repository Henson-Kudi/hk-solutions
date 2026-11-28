# ADR 0014: File storage

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0001 (module boundaries), ADR 0004 (tenant isolation), ADR 0013 (how core
  libs are laid out)

## Context

`core/files` is the second part of plan row 3.1: "S3-compatible, streaming, type sniffing". The
plan says nothing more, so this record fixes what those three words mean here.

## Decision

### Bytes in object storage, facts in a table

The bytes go to an S3-compatible store. A `files` row holds what the file is: purpose, cleaned
name, content type, size, SHA-256, object key, status. Two ports keep them apart, `FileStorage`
and `FileRecords`, each with a conformance suite.

A storage call is never made inside a database transaction. `upload` creates a `pending` record
in one transaction, streams the bytes with no transaction open, then marks the record `stored` in
another. `remove` marks the record `deleted` first and removes the bytes after.

### A stream is an AsyncIterable of byte arrays

That is the one shape a Node stream, a browser stream and a plain object all satisfy, so the
application layer stays pure. The pure libs iterate with plain `next()` calls, not `for await` or
`async function*`, to keep to syntax every target runtime is certain to accept.

### The type is decided from the bytes

A declared content type and a file extension are claims. `sniff` reads the first 512 bytes and
recognises the formats we accept by their signatures. An upload is stored only when the purpose
accepts the declared type **and** the bytes are what that type starts with.

- HTML, SVG and XML are refused under any name: served back to a browser, they run scripts.
- Programs and scripts are refused.
- Text is judged loosely: any byte of 0x80 or above counts as part of a letter. CSV files
  exported by Excel on Windows are in a legacy encoding, not UTF-8, and a strict rule would
  refuse them.

This is not malware scanning. A genuine PDF with hostile content passes.

### Limits are enforced while streaming

Each purpose has a size limit. The bytes are counted as they pass, and the upload fails the moment
the limit is exceeded, without reading the rest. The same pass computes the SHA-256.

### Keys and names carry nothing the user typed

The object key is `tenants/<id>/businesses/<id>/files/<id>`, built from validated UUIDs only. The
stored name is the last path segment of the uploaded name, cleaned, with the extension of the
real type. `open` and `remove` also refuse a record whose key is outside its own business.

### A new boundary tag: `layer:infra-node`

The S3 adapter is server-side infrastructure that is not a database lib. The boundary rules knew
only `infra-pg` and `infra-sqlite`. `layer:infra-node` is a server-side adapter to something
other than PostgreSQL, with the same reach as `infra-pg`: its own layer, application, domain and
platform. The email and SMS adapters of `core/comms` will use it too.

### Checksums only when required, off Amazon

The AWS SDK now adds an integrity checksum to every request by default. Multipart uploads then
failed on the S3-compatible test server, and other non-Amazon services are known to behave the
same. `createS3Client` keeps the SDK default for Amazon S3 and switches to "when required" when a
custom endpoint is given. It can be overridden.

### Tests run against an S3-compatible server

`platform/testing` gains `acquireObjectStore`, like `acquirePostgres`: it uses
`HK_TEST_S3_ENDPOINT` when set, or starts a container when `HK_TEST_CONTAINERS=1`. The server is
Adobe S3Mock, pinned by image digest. MinIO was the first choice, but its images are no longer
published on Docker Hub. The local Compose stack runs the same image on port 9090.

## Consequences

- **Orphans are possible and nothing sweeps them yet.** A crash between the two transactions of
  an upload leaves a `pending` record; a failed delete leaves bytes behind a `deleted` record. A
  scheduled sweep belongs with the worker in row 3.11.
- **The production store is not chosen.** Any S3-compatible service works. The bucket, its
  encryption and its access rules are infrastructure, not created by this code; `ensureBucket`
  is for development and tests.
- **S3Mock is a mock, not a production store.** It proves the adapter speaks the S3 API,
  including multipart uploads and aborts. It does not prove behaviour on a given provider; the
  conformance suite should be run once against the chosen one.
- **Downloads go through the service.** There are no presigned URLs yet. Large downloads will
  want them, and they need a decision on expiry and on who may mint one.
- **Encryption at rest and retention are the store's job.** Neither is set here.
- **No migration file yet**, for the reason given in ADR 0013.
- **The size limits and accepted types are code, not settings.** A business cannot raise them.
