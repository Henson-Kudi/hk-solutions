/**
 * Type sniffing: what a file really is, from its first bytes.
 *
 * The type a client declares, and the extension in a file name, are claims.
 * An upload named invoice.pdf can be a program or a web page. Most formats
 * start with fixed bytes (a "magic number"), so the first bytes say what the
 * file actually is, and an upload whose bytes disagree with its claim is
 * refused.
 *
 * This is not a virus scan. It stops a file from being stored under a false
 * type; it does not judge what a genuine PDF contains.
 */

/** How many bytes sniff() needs to see. A shorter file is sniffed whole. */
export const SNIFF_LENGTH = 512;

export type SniffedKind =
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  /** A ZIP container. Word and Excel files (docx, xlsx) are ZIPs. */
  | 'zip'
  /** Plain text: CSV, TXT. No markup, no control characters. */
  | 'text'
  /** HTML, SVG or XML. Refused: a browser would run scripts inside it. */
  | 'markup'
  /** A program or script. Refused. */
  | 'executable'
  | 'empty'
  | 'unknown';

const startsWith = (
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] =>
  Array.from(text, (char) => char.charCodeAt(0));

const PDF = ascii('%PDF-');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii('GIF87a');
const GIF89 = ascii('GIF89a');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

/** Programs. Checked only on files that are not text, so a CSV starting "MZ" is still a CSV. */
const BINARY_EXECUTABLE_SIGNATURES = [
  ascii('MZ'), // Windows program
  [0x7f, 0x45, 0x4c, 0x46], // Linux program (ELF)
  [0xfe, 0xed, 0xfa, 0xce], // macOS program (Mach-O), and its variants:
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // Java class or macOS universal binary
];

/** A script with an interpreter line: text that an operating system would run. */
const SHEBANG = ascii('#!');

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** Tags that make a text file something a browser would execute. */
const MARKUP = /^\s*<(\?xml|!doctype|html|head|body|svg|script|iframe|!--)/i;
const SCRIPT_ANYWHERE = /<script[\s>]/i;

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;

/** Decodes bytes as Latin-1, which is enough to look for ASCII markers. */
const toLatin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index] ?? 0);
  }
  return text;
};

const looksLikeText = (bytes: Uint8Array): boolean => {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    // NUL and other control characters do not occur in text. Bytes of 0x80
    // and above are fine: they are the parts of UTF-8 letters.
    if (byte < 0x20 && byte !== TAB && byte !== LF && byte !== CR) {
      return false;
    }
    if (byte === 0x7f) {
      return false;
    }
  }
  return true;
};

/** What the first bytes of a file say it is. */
export const sniff = (head: Uint8Array): SniffedKind => {
  if (head.length === 0) return 'empty';
  const bytes =
    head.length > SNIFF_LENGTH ? head.subarray(0, SNIFF_LENGTH) : head;

  if (startsWith(bytes, PDF)) return 'pdf';
  if (startsWith(bytes, PNG)) return 'png';
  if (startsWith(bytes, JPEG)) return 'jpeg';
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'gif';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'webp';
  if (ZIP_SIGNATURES.some((signature) => startsWith(bytes, signature))) {
    return 'zip';
  }
  const body = startsWith(bytes, UTF8_BOM) ? bytes.subarray(3) : bytes;
  if (!looksLikeText(body)) {
    return BINARY_EXECUTABLE_SIGNATURES.some((signature) =>
      startsWith(bytes, signature),
    )
      ? 'executable'
      : 'unknown';
  }
  if (startsWith(body, SHEBANG)) return 'executable';
  const text = toLatin1(body);
  if (MARKUP.test(text) || SCRIPT_ANYWHERE.test(text)) return 'markup';
  return 'text';
};
