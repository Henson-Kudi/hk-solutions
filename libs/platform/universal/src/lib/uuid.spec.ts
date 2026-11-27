import { FixedClock } from './clock';
import { DomainError } from './domain-error';
import {
  createUuidV7Generator,
  isUuid,
  isUuidV7,
  platformRandomSource,
  uuidV7Time,
  uuidv7,
  type RandomSource,
} from './uuid';

const code = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'NOT_A_DOMAIN_ERROR';
  }
  return 'DID_NOT_THROW';
};

/** A repeatable byte stream, so the tests need no platform crypto. */
const sequence = (): RandomSource => {
  let state = 1;
  return (bytes) => {
    for (let index = 0; index < bytes.length; index += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      bytes[index] = (state >>> 16) & 0xff;
    }
    return bytes;
  };
};

const fill =
  (value: number): RandomSource =>
  (bytes) =>
    bytes.fill(value);

type GlobalWithCrypto = { crypto?: unknown };

const withCrypto = (value: unknown, action: () => void): void => {
  const target = globalThis as GlobalWithCrypto;
  const original = Object.getOwnPropertyDescriptor(target, 'crypto');
  Object.defineProperty(target, 'crypto', {
    value,
    configurable: true,
    writable: true,
  });
  try {
    action();
  } finally {
    if (original) {
      Object.defineProperty(target, 'crypto', original);
    } else {
      delete target.crypto;
    }
  }
};

describe('uuidv7', () => {
  it('produces a canonical version 7 UUID', () => {
    const next = createUuidV7Generator({
      clock: new FixedClock('2026-11-27T10:00:00.000Z'),
      random: sequence(),
    });
    const id = next();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(isUuid(id)).toBe(true);
    expect(isUuidV7(id)).toBe(true);
  });

  it('writes the bits exactly as RFC 9562 lays them out', () => {
    const allOnes = createUuidV7Generator({
      clock: new FixedClock(new Date(0x0123456789ab)),
      random: fill(0xff),
    });
    // timestamp 0123456789ab, version 7, counter seed 0x7ff, variant 10, then ones.
    expect(allOnes()).toBe('01234567-89ab-77ff-bfff-ffffffffffff');

    const allZeros = createUuidV7Generator({
      clock: new FixedClock(new Date(0)),
      random: fill(0),
    });
    expect(allZeros()).toBe('00000000-0000-7000-8000-000000000000');
  });

  it('stores the creation time', () => {
    const clock = new FixedClock('2026-11-27T10:00:00.123Z');
    const next = createUuidV7Generator({ clock, random: sequence() });
    expect(uuidV7Time(next()).toISOString()).toBe('2026-11-27T10:00:00.123Z');
  });

  it('sorts in creation order within one millisecond', () => {
    const next = createUuidV7Generator({
      clock: new FixedClock('2026-11-27T10:00:00.000Z'),
      random: sequence(),
    });
    const ids = Array.from({ length: 1000 }, () => next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts in creation order across milliseconds', () => {
    const clock = new FixedClock('2026-11-27T10:00:00.000Z');
    const next = createUuidV7Generator({ clock, random: sequence() });
    const ids: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      ids.push(next());
      if (index % 3 === 0) {
        clock.advance(1);
      }
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('moves the timestamp ahead when the counter runs out', () => {
    const clock = new FixedClock(new Date(1000));
    // 0xff seeds the counter at 0x7ff, leaving 2048 increments.
    const next = createUuidV7Generator({ clock, random: fill(0xff) });
    const ids = Array.from({ length: 5000 }, () => next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(uuidV7Time(ids[ids.length - 1] as string).getTime()).toBeGreaterThan(
      1000,
    );
  });

  it('keeps sorting when the clock goes backwards', () => {
    const clock = new FixedClock('2026-11-27T10:00:00.000Z');
    const next = createUuidV7Generator({ clock, random: sequence() });
    const before = next();
    clock.advance(-60_000);
    const after = next();
    expect(after > before).toBe(true);
    expect(uuidV7Time(after).toISOString()).toBe('2026-11-27T10:00:00.000Z');
  });

  it('refuses a time that does not fit 48 bits', () => {
    const tooEarly = createUuidV7Generator({
      clock: new FixedClock(new Date(-1)),
      random: sequence(),
    });
    expect(code(tooEarly)).toBe('UUID_TIMESTAMP_OUT_OF_RANGE');
  });

  it('refuses a random source that returns the wrong length', () => {
    const next = createUuidV7Generator({
      clock: new FixedClock(new Date(0)),
      random: () => new Uint8Array(4),
    });
    expect(code(next)).toBe('RANDOM_SOURCE_INVALID');
  });

  it('uses crypto.getRandomValues where the platform has it', () => {
    const calls: number[] = [];
    const fake = {
      getRandomValues: (bytes: Uint8Array) => {
        calls.push(bytes.length);
        return bytes.fill(7);
      },
    };
    withCrypto(fake, () => {
      expect(platformRandomSource(new Uint8Array(3))).toEqual(
        new Uint8Array([7, 7, 7]),
      );
      expect(isUuidV7(uuidv7())).toBe(true);
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('throws a clear error where the platform has no crypto, as on Hermes', () => {
    withCrypto(undefined, () => {
      expect(code(() => platformRandomSource(new Uint8Array(1)))).toBe(
        'RANDOM_SOURCE_UNAVAILABLE',
      );
      expect(
        code(createUuidV7Generator({ clock: new FixedClock(new Date(0)) })),
      ).toBe('RANDOM_SOURCE_UNAVAILABLE');
    });
  });

  it('recognises UUIDs in canonical lower case only', () => {
    expect(isUuid('01234567-89ab-4def-8123-456789abcdef')).toBe(true);
    expect(isUuidV7('01234567-89ab-4def-8123-456789abcdef')).toBe(false);
    expect(isUuid('01234567-89AB-7DEF-8123-456789ABCDEF')).toBe(false);
    expect(isUuid('0123456789ab7def8123456789abcdef')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(code(() => uuidV7Time('not-a-uuid'))).toBe('UUID_NOT_V7');
  });
});
