import type { Result } from '@hk/platform/universal';
import {
  isObjectKeyOf,
  objectKeyFor,
  objectPrefixFor,
  safeFileName,
  type FileScope,
} from './file';
import {
  CONTENT_TYPES,
  FILE_ERRORS,
  FILE_PURPOSES,
  checkUpload,
  isContentType,
  isFilePurpose,
  policyFor,
  tooLarge,
  type ContentType,
} from './file-policy';
import { SNIFF_LENGTH, sniff } from './sniff';

const ascii = (text: string): Uint8Array =>
  Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const PDF = ascii('%PDF-1.7\n%âãÏÓ\n1 0 obj\n');
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
const GIF = ascii('GIF89a\u0001\u0000\u0001\u0000');
const WEBP = join(ascii('RIFF'), bytes(0x24, 0, 0, 0), ascii('WEBPVP8 '));
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00);
const CSV = ascii('code,name\n411,Clients\n');
const EXE = join(ascii('MZ'), bytes(0x90, 0x00, 0x03, 0x00, 0x00, 0x00));
const ELF = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00);

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const codeOf = (result: Result<unknown>): string | null =>
  result.ok ? null : result.error.code;

describe('sniff', () => {
  it.each<[string, Uint8Array, string]>([
    ['a PDF', PDF, 'pdf'],
    ['a PNG', PNG, 'png'],
    ['a JPEG', JPEG, 'jpeg'],
    ['a GIF', GIF, 'gif'],
    ['an older GIF', ascii('GIF87a....'), 'gif'],
    ['a WebP', WEBP, 'webp'],
    ['a ZIP', ZIP, 'zip'],
    ['an empty ZIP', bytes(0x50, 0x4b, 0x05, 0x06, 0, 0), 'zip'],
    ['a CSV', CSV, 'text'],
    ['plain text', ascii('Hello, world.'), 'text'],
    ['text with tabs and Windows line ends', ascii('a\tb\r\nc\td\r\n'), 'text'],
    ['a single character', ascii('x'), 'text'],
    [
      'text in UTF-8 with accents',
      bytes(0x43, 0x61, 0x66, 0xc3, 0xa9, 0x0a),
      'text',
    ],
    [
      'text that starts with a byte order mark',
      join(bytes(0xef, 0xbb, 0xbf), ascii('code,name\n')),
      'text',
    ],
    [
      'a CSV whose first cell is "MZ"',
      ascii('MZ,Mozambique\nCM,Cameroon\n'),
      'text',
    ],
    ['nothing', new Uint8Array(0), 'empty'],
  ])('recognises %s', (_name, head, expected) => {
    expect(sniff(head)).toBe(expected);
  });

  it.each<[string, Uint8Array]>([
    ['a Windows program', EXE],
    ['a Linux program', ELF],
    ['a macOS program', bytes(0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01)],
    ['a Java class', bytes(0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34)],
    ['a shell script', ascii('#!/bin/sh\nrm -rf /\n')],
    [
      'a script behind a byte order mark',
      join(bytes(0xef, 0xbb, 0xbf), ascii('#!/usr/bin/env node\n')),
    ],
  ])('calls %s executable', (_name, head) => {
    expect(sniff(head)).toBe('executable');
  });

  it.each<[string, string]>([
    ['an HTML page', '<!DOCTYPE html><html><body>hi</body></html>'],
    ['HTML without a doctype', '<html><script>alert(1)</script></html>'],
    ['HTML after blank lines', '\n\n   <HTML>'],
    ['an SVG image', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['an XML file', '<?xml version="1.0"?><root/>'],
    ['a bare script tag', '<script>alert(1)</script>'],
    ['text with a script tag further in', 'name,note\nx,<script src=//evil>\n'],
    ['an HTML comment', '<!-- hidden --><p>x</p>'],
    ['an iframe', '<iframe src="//evil"></iframe>'],
  ])('calls %s markup', (_name, content) => {
    expect(sniff(ascii(content))).toBe('markup');
  });

  it('does not call a CSV markup because it mentions a tag in words', () => {
    expect(sniff(ascii('note\nuse the script we agreed\nprice < 10\n'))).toBe(
      'text',
    );
  });

  it.each<[string, Uint8Array]>([
    ['bytes with a NUL in them', bytes(0x61, 0x00, 0x62, 0x63)],
    ['random binary', bytes(0x01, 0x02, 0x03, 0x04, 0x05)],
    [
      'RIFF that is not WebP',
      join(ascii('RIFF'), bytes(0, 0, 0, 0), ascii('WAVE')),
    ],
    ['a DEL character among text', bytes(0x61, 0x7f, 0x62)],
  ])('does not know %s', (_name, head) => {
    expect(sniff(head)).toBe('unknown');
  });

  it('accepts text in a legacy encoding, as Excel on Windows exports it', () => {
    // "café" in Windows-1252: é is the single byte 0xE9, which is not UTF-8.
    // Refusing it would refuse real CSV exports, so any byte of 0x80 and
    // above counts as part of a letter.
    expect(sniff(bytes(0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a))).toBe('text');
  });

  it('looks only at the first bytes', () => {
    const head = new Uint8Array(SNIFF_LENGTH + 100).fill(0x61);
    // A NUL after the sniffed part does not change the answer.
    head[SNIFF_LENGTH + 10] = 0;
    expect(sniff(head)).toBe('text');
    head[SNIFF_LENGTH - 1] = 0;
    expect(sniff(head)).toBe('unknown');
  });

  it('is not fooled by a signature that is not at the start', () => {
    expect(sniff(join(ascii('xx'), PDF))).toBe('text');
    expect(sniff(join(bytes(0x00), PNG))).toBe('unknown');
  });
});

describe('checkUpload', () => {
  const check = (purpose: string, declaredType: string, head: Uint8Array) =>
    checkUpload({ purpose, declaredType, head });

  it.each<[string, string, Uint8Array]>([
    ['attachment', 'application/pdf', PDF],
    ['attachment', 'image/png', PNG],
    ['attachment', 'image/jpeg', JPEG],
    ['attachment', 'image/webp', WEBP],
    ['attachment', DOCX, ZIP],
    ['attachment', XLSX, ZIP],
    ['image', 'image/gif', GIF],
    ['image', 'image/png', PNG],
    ['import', 'text/csv', CSV],
    ['import', 'text/plain', CSV],
    ['import', XLSX, ZIP],
    ['export', 'application/zip', ZIP],
    ['export', 'application/pdf', PDF],
  ])('accepts a %s declared as %s', (purpose, declaredType, head) => {
    const result = check(purpose, declaredType, head);
    expect(result.ok && result.value).toBe(declaredType);
  });

  it('ignores case and spaces around the declared type', () => {
    const result = check('attachment', '  Application/PDF ', PDF);
    expect(result.ok && result.value).toBe('application/pdf');
  });

  it.each<[string, string, string, Uint8Array]>([
    ['a program named as a PDF', 'attachment', 'application/pdf', EXE],
    [
      'a web page named as a PDF',
      'attachment',
      'application/pdf',
      ascii('<html>'),
    ],
    ['a PNG named as a JPEG', 'attachment', 'image/jpeg', PNG],
    ['a PDF named as an image', 'image', 'image/png', PDF],
    ['a ZIP named as a CSV', 'import', 'text/csv', ZIP],
    ['a script named as a CSV', 'import', 'text/csv', ascii('#!/bin/sh\n')],
    [
      'a web page named as a CSV',
      'import',
      'text/csv',
      ascii('<script>x</script>'),
    ],
    ['a CSV named as a spreadsheet', 'import', XLSX, CSV],
    [
      'unknown bytes named as a PDF',
      'attachment',
      'application/pdf',
      bytes(1, 2, 3),
    ],
  ])('refuses %s', (_name, purpose, declaredType, head) => {
    expect(codeOf(check(purpose, declaredType, head))).toBe(
      FILE_ERRORS.TYPE_MISMATCH,
    );
  });

  it('says what was expected and what was found, and nothing of the content', () => {
    const result = check(
      'import',
      'text/csv',
      ascii('<script>steal()</script>'),
    );
    expect(!result.ok && result.error.details).toEqual({
      declared: 'text/csv',
      expected: 'text',
      found: 'markup',
    });
    expect(!result.ok && JSON.stringify(result.error.toJSON())).not.toContain(
      'steal',
    );
  });

  it.each<[string, string, string]>([
    ['a CSV as an attachment', 'attachment', 'text/csv'],
    ['a PDF as an image', 'image', 'application/pdf'],
    ['a ZIP as an import', 'import', 'application/zip'],
    ['an HTML page', 'attachment', 'text/html'],
    ['an SVG', 'image', 'image/svg+xml'],
    ['a program', 'attachment', 'application/x-msdownload'],
    ['no type', 'attachment', ''],
    ['a type that is a property of every object', 'attachment', 'constructor'],
  ])('does not accept %s', (_name, purpose, declaredType) => {
    expect(codeOf(check(purpose, declaredType, PDF))).toBe(
      FILE_ERRORS.TYPE_NOT_ALLOWED,
    );
  });

  it('refuses an empty file', () => {
    expect(
      codeOf(check('attachment', 'application/pdf', new Uint8Array(0))),
    ).toBe(FILE_ERRORS.EMPTY);
  });

  it('refuses an unknown purpose', () => {
    for (const purpose of ['', 'avatar', 'toString', 'constructor']) {
      expect(codeOf(check(purpose, 'application/pdf', PDF))).toBe(
        FILE_ERRORS.PURPOSE_UNKNOWN,
      );
    }
  });
});

describe('file policy', () => {
  it('knows its purposes and types', () => {
    expect(Object.keys(FILE_PURPOSES)).toEqual([
      'attachment',
      'image',
      'import',
      'export',
    ]);
    expect(isFilePurpose('attachment')).toBe(true);
    expect(isFilePurpose('hasOwnProperty')).toBe(false);
    expect(isContentType('application/pdf')).toBe(true);
    expect(isContentType('text/html')).toBe(false);
    expect(isContentType('toString')).toBe(false);
  });

  it('accepts only known types for every purpose, with a size limit', () => {
    for (const policy of Object.values(FILE_PURPOSES)) {
      expect(policy.types.length).toBeGreaterThan(0);
      expect(policy.maxBytes).toBeGreaterThan(0);
      expect(Number.isInteger(policy.maxBytes)).toBe(true);
      for (const type of policy.types) {
        expect(isContentType(type)).toBe(true);
      }
    }
  });

  it('never accepts anything a browser would run', () => {
    const types = Object.keys(CONTENT_TYPES);
    for (const banned of ['text/html', 'image/svg+xml', 'application/xml']) {
      expect(types).not.toContain(banned);
    }
    for (const entry of Object.values(CONTENT_TYPES)) {
      expect(['markup', 'executable', 'unknown', 'empty']).not.toContain(
        entry.kind,
      );
    }
  });

  it('sets the limits', () => {
    const mb = 1024 * 1024;
    expect(policyFor('attachment').maxBytes).toBe(10 * mb);
    expect(policyFor('image').maxBytes).toBe(5 * mb);
    expect(policyFor('import').maxBytes).toBe(20 * mb);
    expect(policyFor('export').maxBytes).toBe(50 * mb);
  });

  it('builds the too-large error with the limit', () => {
    const error = tooLarge('image');
    expect(error.code).toBe(FILE_ERRORS.TOO_LARGE);
    expect(error.details).toEqual({
      purpose: 'image',
      limitBytes: 5 * 1024 * 1024,
    });
  });
});

describe('safeFileName', () => {
  const pdf: ContentType = 'application/pdf';

  it.each<[string, unknown, string]>([
    ['a plain name', 'invoice.pdf', 'invoice.pdf'],
    [
      'a name with spaces',
      'March  invoice   2026.pdf',
      'March invoice 2026.pdf',
    ],
    ['a Unix path', '/home/user/docs/invoice.pdf', 'invoice.pdf'],
    ['a Windows path', 'C:\\Users\\me\\invoice.pdf', 'invoice.pdf'],
    ['a path that climbs', '../../etc/passwd', 'passwd.pdf'],
    ['a hidden file', '.htaccess', 'htaccess.pdf'],
    ['only dots', '...', 'file.pdf'],
    ['a wrong extension', 'report.exe', 'report.pdf'],
    ['a double extension', 'report.pdf.exe', 'report.pdf.pdf'],
    ['no extension', 'report', 'report.pdf'],
    ['an empty name', '', 'file.pdf'],
    ['only spaces', '   ', 'file.pdf'],
    ['not a string', undefined, 'file.pdf'],
    ['a number', 42, 'file.pdf'],
    [
      'a line break',
      'evil\r\nSet-Cookie: x=1.pdf',
      'evil__Set-Cookie_ x=1.pdf',
    ],
    ['shell characters', 'a<b>c:"d"|e?f*.pdf', 'a_b_c__d__e_f.pdf'],
    ['accents', 'reçu café.pdf', 'reçu café.pdf'],
    ['Arabic', 'فاتورة.pdf', 'فاتورة.pdf'],
    ['a trailing dot', 'invoice..pdf', 'invoice.pdf'],
  ])('handles %s', (_name, input, expected) => {
    expect(safeFileName(input, pdf)).toBe(expected);
  });

  it('gives the extension of the real type', () => {
    expect(safeFileName('photo.png', 'image/jpeg')).toBe('photo.jpg');
    expect(safeFileName('data.txt', 'text/csv')).toBe('data.csv');
    expect(
      safeFileName(
        'sheet.zip',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('sheet.xlsx');
  });

  it('keeps names to 120 characters', () => {
    const name = safeFileName(`${'a'.repeat(500)}.pdf`, pdf);
    expect(name).toHaveLength(120);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('never returns a path separator or a control character', () => {
    for (const input of [
      'a/b\\c.pdf',
      '\u0000\u0001name\u007f.pdf',
      '..\\..\\x',
      '/',
      '\\',
    ]) {
      const name = safeFileName(input, pdf);
      expect(name).not.toMatch(/[/\\]/);
      expect(Array.from(name).every((char) => char.charCodeAt(0) >= 0x20)).toBe(
        true,
      );
      expect(name.startsWith('.')).toBe(false);
    }
  });
});

describe('object keys', () => {
  const scope: FileScope = {
    tenantId: '018f0000-0000-7000-8000-00000000000a',
    businessId: '018f0000-0000-7000-8000-00000000000b',
  };
  const other: FileScope = {
    tenantId: scope.tenantId,
    businessId: '018f0000-0000-7000-8000-00000000000c',
  };
  const fileId = '018f0000-0000-7000-8000-0000000000f1';

  it('puts a file under its tenant and business', () => {
    expect(objectKeyFor(scope, fileId)).toBe(
      'tenants/018f0000-0000-7000-8000-00000000000a/businesses/018f0000-0000-7000-8000-00000000000b/files/018f0000-0000-7000-8000-0000000000f1',
    );
    expect(objectPrefixFor(scope)).toBe(
      'tenants/018f0000-0000-7000-8000-00000000000a/businesses/018f0000-0000-7000-8000-00000000000b/files/',
    );
  });

  it('refuses anything that is not an id, so no input can shape a key', () => {
    expect(() => objectKeyFor(scope, '../../other')).toThrow(/fileId/);
    expect(() => objectKeyFor(scope, 'invoice.pdf')).toThrow(/fileId/);
    expect(() => objectKeyFor({ ...scope, businessId: '..' }, fileId)).toThrow(
      /businessId/,
    );
    expect(() => objectKeyFor({ ...scope, tenantId: '' }, fileId)).toThrow(
      /tenantId/,
    );
  });

  it('knows which keys belong to a business', () => {
    const key = objectKeyFor(scope, fileId);
    expect(isObjectKeyOf(scope, key)).toBe(true);
    expect(isObjectKeyOf(other, key)).toBe(false);
    expect(isObjectKeyOf(scope, `${key}/../x`)).toBe(false);
    expect(isObjectKeyOf(scope, `${objectPrefixFor(scope)}not-an-id`)).toBe(
      false,
    );
    expect(isObjectKeyOf(scope, `x/${key}`)).toBe(false);
  });

  it('gives two businesses prefixes that do not contain each other', () => {
    expect(objectPrefixFor(scope).startsWith(objectPrefixFor(other))).toBe(
      false,
    );
    expect(objectPrefixFor(other).startsWith(objectPrefixFor(scope))).toBe(
      false,
    );
  });
});
