import { isUuid } from '@hk/platform/universal';
import {
  CONTENT_TYPES,
  type ContentType,
  type FilePurpose,
} from './file-policy';

/** The business a file belongs to. */
export interface FileScope {
  readonly tenantId: string;
  readonly businessId: string;
}

/**
 * pending   the record exists and the bytes are on their way to storage
 * stored    the bytes are in storage; the file can be read
 * deleted   the file was removed; the record stays as a trace
 */
export const FILE_STATUSES = ['pending', 'stored', 'deleted'] as const;

export type FileStatus = (typeof FILE_STATUSES)[number];

/** What is known about a stored file. The bytes themselves are in object storage. */
export interface FileRecord extends FileScope {
  readonly id: string;
  readonly purpose: FilePurpose;
  /** The name to show and to download under. Already made safe. */
  readonly name: string;
  readonly contentType: ContentType;
  readonly status: FileStatus;
  /** Size in bytes. Null until the file is stored. */
  readonly size: number | null;
  /** SHA-256 of the bytes, 64 hex characters. Null until the file is stored. */
  readonly sha256: string | null;
  /** Where the bytes are in object storage. */
  readonly objectKey: string;
  /** ISO 8601 instant. */
  readonly createdAt: string;
  readonly createdBy: string | null;
}

const MAX_NAME = 120;
/** Characters that mean something to a file system, a shell or an HTTP header. */
const UNSAFE_CHARACTERS = '<>:"/\\|?*';

const isUnsafe = (char: string): boolean => {
  const code = char.charCodeAt(0);
  // Control characters, line breaks included, and DEL.
  return code < 0x20 || code === 0x7f || UNSAFE_CHARACTERS.includes(char);
};

const replaceUnsafe = (text: string): string =>
  Array.from(text, (char) => (isUnsafe(char) ? '_' : char)).join('');

/**
 * Makes an uploaded file name safe to store, show and send back.
 *
 * A name comes from the uploader's machine and can be anything:
 * "../../etc/passwd", a name with line breaks, 500 characters. Only the last
 * path segment is kept, unsafe characters become "_", and the extension is
 * replaced by the one that belongs to the file's real type, so a file that
 * is a PDF is never offered for download as "report.exe".
 */
export const safeFileName = (
  name: unknown,
  contentType: ContentType,
): string => {
  const extension = CONTENT_TYPES[contentType].extension;
  const raw = typeof name === 'string' ? name : '';
  const lastSegment = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = replaceUnsafe(lastSegment.normalize('NFC'))
    .replace(/\s+/g, ' ')
    .trim()
    // No leading dots: no hidden files, no "..".
    .replace(/^[.\s_]+/, '');
  const dot = cleaned.lastIndexOf('.');
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned)
    .replace(/[.\s_]+$/, '')
    .slice(0, MAX_NAME - extension.length - 1);
  return `${stem.length > 0 ? stem : 'file'}.${extension}`;
};

/**
 * Where a file's bytes live in object storage.
 *
 * The key is built only from ids, never from the file name or anything else
 * a user typed, so no input can steer a file into another business's folder.
 * Each business has its own prefix, which is also what a storage policy or a
 * per-business export works on.
 */
export const objectKeyFor = (scope: FileScope, fileId: string): string => {
  for (const [what, value] of [
    ['tenantId', scope.tenantId],
    ['businessId', scope.businessId],
    ['fileId', fileId],
  ] as const) {
    if (!isUuid(value)) {
      throw new Error(`Cannot build an object key: ${what} is not a UUID.`);
    }
  }
  return `tenants/${scope.tenantId}/businesses/${scope.businessId}/files/${fileId}`;
};

/** The prefix every object of a business starts with. */
export const objectPrefixFor = (scope: FileScope): string =>
  objectKeyFor(scope, '00000000-0000-0000-0000-000000000000').replace(
    /[^/]+$/,
    '',
  );

/** Whether a key belongs to the business. */
export const isObjectKeyOf = (scope: FileScope, key: string): boolean =>
  key.startsWith(objectPrefixFor(scope)) &&
  isUuid(key.slice(objectPrefixFor(scope).length));
