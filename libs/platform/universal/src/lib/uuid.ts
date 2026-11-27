import { systemClock, type Clock } from './clock';
import { DomainError } from './domain-error';

/** A UUID in canonical form: lower-case hex, 8-4-4-4-12. */
export type Uuid = string & { readonly __brand: 'Uuid' };

/**
 * Fills the given array with cryptographically strong random bytes and returns
 * it. The shape matches crypto.getRandomValues, so platform functions fit
 * without a wrapper.
 */
export type RandomSource = (bytes: Uint8Array) => Uint8Array;

export interface UuidV7Options {
  /** Defaults to the system clock. */
  clock?: Clock;
  /** Defaults to the platform's crypto.getRandomValues. Hermes has none: pass one. */
  random?: RandomSource;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_TIMESTAMP = 2 ** 48 - 1;
const MAX_COUNTER = 0xfff;
const RANDOM_BYTES = 10;

const HEX: string[] = [];
for (let byte = 0; byte < 256; byte += 1) {
  HEX.push(byte.toString(16).padStart(2, '0'));
}

interface PlatformCrypto {
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}

/**
 * Uses the Web Crypto API that Node and browsers provide. Throws where there
 * is none (React Native on Hermes) instead of falling back to Math.random,
 * because ids generated offline on many devices must not collide.
 */
export const platformRandomSource: RandomSource = (bytes) => {
  const platform = (globalThis as { crypto?: PlatformCrypto }).crypto;
  if (typeof platform?.getRandomValues !== 'function') {
    throw new DomainError(
      'RANDOM_SOURCE_UNAVAILABLE',
      'No crypto.getRandomValues on this platform. Pass a RandomSource to createUuidV7Generator.',
      { kind: 'invariant' },
    );
  }
  return platform.getRandomValues(bytes);
};

const format = (bytes: Uint8Array): Uuid => {
  let text = '';
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) {
      text += '-';
    }
    text += HEX[bytes[index] as number];
  }
  return text as Uuid;
};

/**
 * Returns a function that makes UUID version 7 values (RFC 9562).
 *
 * Layout: 48 bits of Unix time in milliseconds, 4 bits version, a 12-bit
 * counter, 2 bits variant, 62 random bits.
 *
 * Ids from one generator always sort in the order they were made, which keeps
 * database indexes compact and lets a device create ids offline:
 * - within one millisecond the counter goes up by one;
 * - if the counter runs out, the timestamp moves one millisecond ahead;
 * - if the clock goes backwards, the last timestamp is kept.
 */
export const createUuidV7Generator = (
  options: UuidV7Options = {},
): (() => Uuid) => {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? platformRandomSource;

  let lastTimestamp = -1;
  let counter = 0;

  return () => {
    const now = clock.now().getTime();
    if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
      throw new DomainError(
        'UUID_TIMESTAMP_OUT_OF_RANGE',
        'The clock returned a time that does not fit a UUID v7 timestamp.',
        { kind: 'invariant' },
      );
    }

    const entropy = random(new Uint8Array(RANDOM_BYTES));
    if (entropy.length !== RANDOM_BYTES) {
      throw new DomainError(
        'RANDOM_SOURCE_INVALID',
        'The random source returned the wrong number of bytes.',
        { kind: 'invariant' },
      );
    }

    // Start each new millisecond at a random value with the top bit clear, so
    // there are always at least 2048 increments before the counter runs out.
    const seed =
      (((entropy[0] as number) << 8) | (entropy[1] as number)) & 0x7ff;

    if (now > lastTimestamp) {
      lastTimestamp = now;
      counter = seed;
    } else if (counter < MAX_COUNTER) {
      counter += 1;
    } else {
      lastTimestamp += 1;
      counter = seed;
    }

    const bytes = new Uint8Array(16);
    const high = Math.floor(lastTimestamp / 2 ** 32);
    const low = lastTimestamp % 2 ** 32;
    bytes[0] = (high >>> 8) & 0xff;
    bytes[1] = high & 0xff;
    bytes[2] = Math.floor(low / 2 ** 24) & 0xff;
    bytes[3] = (low >>> 16) & 0xff;
    bytes[4] = (low >>> 8) & 0xff;
    bytes[5] = low & 0xff;
    bytes[6] = 0x70 | (counter >>> 8);
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | ((entropy[2] as number) & 0x3f);
    bytes.set(entropy.subarray(3), 9);
    return format(bytes);
  };
};

let defaultGenerator: (() => Uuid) | undefined;

/**
 * A new UUID v7 from the system clock and the platform random source.
 * Use cases should take ids from an injected port; this is for the adapters
 * that implement that port on Node and in the browser.
 */
export const uuidv7 = (): Uuid => {
  defaultGenerator ??= createUuidV7Generator();
  return defaultGenerator();
};

/** True for any UUID version in canonical lower-case form. */
export const isUuid = (value: unknown): value is Uuid =>
  typeof value === 'string' && UUID.test(value);

export const isUuidV7 = (value: unknown): value is Uuid =>
  typeof value === 'string' && UUID_V7.test(value);

/** The creation time stored in a UUID v7. */
export const uuidV7Time = (id: string): Date => {
  if (!isUuidV7(id)) {
    throw new DomainError('UUID_NOT_V7', 'Value is not a UUID version 7.');
  }
  return new Date(parseInt(id.slice(0, 8) + id.slice(9, 13), 16));
};
