import { DomainError, err, ok, type Result } from '@hk/platform/universal';
import { sniff, type SniffedKind } from './sniff';

/**
 * What may be uploaded: which types, for which purpose, up to what size.
 *
 * A type is allowed only if it is on the list for the purpose AND the file's
 * first bytes are what that type starts with.
 */

export const FILE_ERRORS = {
  /** The declared type is not accepted for this purpose. */
  TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  /** The file's bytes are not what its declared type says. */
  TYPE_MISMATCH: 'FILE_TYPE_MISMATCH',
  EMPTY: 'FILE_EMPTY',
  TOO_LARGE: 'FILE_TOO_LARGE',
  PURPOSE_UNKNOWN: 'FILE_PURPOSE_UNKNOWN',
  NOT_FOUND: 'FILE_NOT_FOUND',
  /** The record exists but the bytes are not in storage. */
  OBJECT_NOT_FOUND: 'FILE_OBJECT_NOT_FOUND',
} as const;

/** Each accepted content type, and what its first bytes must be. */
export const CONTENT_TYPES = {
  'application/pdf': { kind: 'pdf', extension: 'pdf' },
  'image/png': { kind: 'png', extension: 'png' },
  'image/jpeg': { kind: 'jpeg', extension: 'jpg' },
  'image/gif': { kind: 'gif', extension: 'gif' },
  'image/webp': { kind: 'webp', extension: 'webp' },
  'text/csv': { kind: 'text', extension: 'csv' },
  'text/plain': { kind: 'text', extension: 'txt' },
  'application/zip': { kind: 'zip', extension: 'zip' },
  // Word and Excel files are ZIP containers.
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'zip',
    extension: 'xlsx',
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'zip',
    extension: 'docx',
  },
} as const satisfies Record<string, { kind: SniffedKind; extension: string }>;

export type ContentType = keyof typeof CONTENT_TYPES;

export const isContentType = (value: unknown): value is ContentType =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(CONTENT_TYPES, value);

const MB = 1024 * 1024;

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;

export interface FilePurposePolicy {
  readonly types: readonly ContentType[];
  /** The largest file accepted, in bytes. */
  readonly maxBytes: number;
}

/** Why a file is being stored. Each purpose accepts its own types and sizes. */
export const FILE_PURPOSES = {
  /** A receipt, contract or other document attached to a record. */
  attachment: {
    types: [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      DOCX,
      XLSX,
    ],
    maxBytes: 10 * MB,
  },
  /** A logo or product picture, shown in the app. */
  image: {
    types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    maxBytes: 5 * MB,
  },
  /** Data a user brings in: a chart of accounts, opening balances, a catalog. */
  import: {
    types: ['text/csv', 'text/plain', XLSX],
    maxBytes: 20 * MB,
  },
  /** A file the system produced: a report, a payment file, an audit export. */
  export: {
    types: [
      'application/pdf',
      'text/csv',
      'text/plain',
      XLSX,
      'application/zip',
    ],
    maxBytes: 50 * MB,
  },
} as const satisfies Record<string, FilePurposePolicy>;

export type FilePurpose = keyof typeof FILE_PURPOSES;

export const isFilePurpose = (value: unknown): value is FilePurpose =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(FILE_PURPOSES, value);

export const policyFor = (purpose: FilePurpose): FilePurposePolicy =>
  FILE_PURPOSES[purpose];

/**
 * Decides whether a file may be stored, from its purpose, the type the
 * uploader declared and its first bytes. Returns the accepted content type.
 *
 * The error says what was expected and what was found. It never quotes the
 * file's content.
 */
export const checkUpload = (input: {
  purpose: string;
  declaredType: string;
  head: Uint8Array;
}): Result<ContentType> => {
  if (!isFilePurpose(input.purpose)) {
    return err(
      new DomainError(
        FILE_ERRORS.PURPOSE_UNKNOWN,
        'That is not a known file purpose.',
      ),
    );
  }
  const policy = policyFor(input.purpose);
  const declared = String(input.declaredType).trim().toLowerCase();
  if (!isContentType(declared) || !policy.types.includes(declared)) {
    return err(
      new DomainError(
        FILE_ERRORS.TYPE_NOT_ALLOWED,
        'That type of file is not accepted here.',
        { details: { purpose: input.purpose } },
      ),
    );
  }
  const found = sniff(input.head);
  if (found === 'empty') {
    return err(new DomainError(FILE_ERRORS.EMPTY, 'The file is empty.'));
  }
  const expected = CONTENT_TYPES[declared].kind;
  if (found !== expected) {
    return err(
      new DomainError(
        FILE_ERRORS.TYPE_MISMATCH,
        'The file is not what its type says it is.',
        { details: { declared, expected, found } },
      ),
    );
  }
  return ok(declared);
};

export const tooLarge = (purpose: FilePurpose): DomainError =>
  new DomainError(
    FILE_ERRORS.TOO_LARGE,
    'The file is larger than the limit for its purpose.',
    { details: { purpose, limitBytes: policyFor(purpose).maxBytes } },
  );
