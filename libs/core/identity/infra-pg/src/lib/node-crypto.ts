import {
  argon2,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { OtpCodec, PasswordHasher } from '@hk/core/identity/application';
import { OTP_RULES } from '@hk/core/identity/domain';

/**
 * The server's cryptography for identity: Argon2id for passwords and
 * HMAC-SHA-256 for one-time codes, both from Node's own crypto module. No
 * third-party library is involved.
 */

const argon2Async = promisify(argon2);

export interface Argon2idParameters {
  /** Memory in KiB. */
  memoryKiB: number;
  /** Passes over the memory. */
  passes: number;
  parallelism: number;
}

/**
 * OWASP's recommended minimum for Argon2id (Password Storage Cheat Sheet):
 * 19 MiB of memory, 2 passes, 1 lane. Each stored hash carries the
 * parameters it was made with, so these can be raised later without
 * breaking the hashes already stored.
 */
export const ARGON2ID_DEFAULTS: Argon2idParameters = {
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
};

const SALT_BYTES = 16;
const TAG_BYTES = 32;

/**
 * Limits on the parameters read back from a stored hash. A corrupted or
 * planted hash must not be able to make the server spend a gigabyte or a
 * minute checking a password.
 */
const VERIFY_LIMITS = { memoryKiB: 262_144, passes: 10, parallelism: 8 };

const base64 = (bytes: Buffer): string =>
  bytes.toString('base64').replace(/=+$/, '');

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,86})$/;

const derive = (
  password: string,
  salt: Buffer,
  parameters: Argon2idParameters,
  tagLength: number,
): Promise<Buffer> =>
  argon2Async('argon2id', {
    // NFKC, so the same password typed on two keyboards gives the same bytes.
    message: Buffer.from(password.normalize('NFKC'), 'utf8'),
    nonce: salt,
    memory: parameters.memoryKiB,
    passes: parameters.passes,
    parallelism: parameters.parallelism,
    tagLength,
  });

/**
 * Argon2id password hashing. The result is a PHC string:
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, the same form other
 * Argon2 libraries read and write.
 */
export const createArgon2idPasswordHasher = (
  parameters: Argon2idParameters = ARGON2ID_DEFAULTS,
): PasswordHasher => ({
  hash: async (password) => {
    const salt = randomBytes(SALT_BYTES);
    const tag = await derive(password, salt, parameters, TAG_BYTES);
    return `$argon2id$v=19$m=${parameters.memoryKiB},t=${parameters.passes},p=${parameters.parallelism}$${base64(salt)}$${base64(tag)}`;
  },
  verify: async (password, hash) => {
    const match = PHC.exec(hash);
    if (!match) return false;
    const stored: Argon2idParameters = {
      memoryKiB: Number(match[1]),
      passes: Number(match[2]),
      parallelism: Number(match[3]),
    };
    if (
      stored.memoryKiB < 8 * stored.parallelism ||
      stored.memoryKiB > VERIFY_LIMITS.memoryKiB ||
      stored.passes < 1 ||
      stored.passes > VERIFY_LIMITS.passes ||
      stored.parallelism < 1 ||
      stored.parallelism > VERIFY_LIMITS.parallelism
    ) {
      return false;
    }
    const salt = Buffer.from(match[4] as string, 'base64');
    const expected = Buffer.from(match[5] as string, 'base64');
    if (salt.length < 8 || expected.length < 16) return false;
    try {
      const actual = await derive(password, salt, stored, expected.length);
      return timingSafeEqual(actual, expected);
    } catch {
      // Parameters Node refuses: a hash this server cannot read.
      return false;
    }
  },
});

/** The shortest secret accepted: 32 bytes, the size of the HMAC's output. */
export const OTP_SECRET_MIN_BYTES = 32;

/**
 * One-time codes for production: digits from the operating system's secure
 * random source, stored as HMAC-SHA-256 under a server secret.
 *
 * Why keyed: a six-digit code has only a million possibilities, so a plain
 * hash of it can be reversed in a moment. With a key that is not in the
 * database, a copy of the table reveals nothing.
 *
 * `secret` comes from the service's configuration, never from code.
 */
export const createHmacOtpCodec = (secret: Uint8Array): OtpCodec => {
  if (secret.byteLength < OTP_SECRET_MIN_BYTES) {
    throw new Error('The one-time code secret must be at least 32 bytes long.');
  }
  const key = Buffer.from(secret);
  const limit = 10 ** OTP_RULES.length;
  return {
    // randomInt draws without modulo bias: every code is equally likely.
    generate: () => String(randomInt(0, limit)).padStart(OTP_RULES.length, '0'),
    hash: (code, binding) =>
      createHmac('sha256', key)
        // The length prefix keeps (binding, code) pairs from running together.
        .update(`${binding.length}:${binding}:${code}`, 'utf8')
        .digest('hex'),
  };
};
