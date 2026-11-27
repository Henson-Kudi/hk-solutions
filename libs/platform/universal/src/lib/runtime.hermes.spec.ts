/**
 * Runs only under the Hermes-compatible target (jest.hermes.config.cts).
 *
 * It proves the target is what it claims to be: if these fail, the other
 * suites passing "on Hermes" would mean nothing.
 */
import { createUuidV7Generator, isUuidV7, uuidv7 } from '../index';

const scope = globalThis as Record<string, unknown>;

describe('Hermes-compatible target', () => {
  it('is the target this file expects', () => {
    expect(scope['__HERMES_TARGET__']).toBe(true);
  });

  it.each(['Buffer', 'crypto', 'structuredClone', 'TextDecoder'])(
    'has no global %s',
    (name) => {
      expect(scope[name]).toBeUndefined();
    },
  );

  it.each(['node:fs', 'fs', 'crypto', 'node:crypto', 'path', 'fs/promises'])(
    'refuses to load the Node built-in %s',
    (name) => {
      expect(() => require(name)).toThrow(/Node built-in module/);
    },
  );

  it('makes the default id generator fail loudly, since there is no crypto', () => {
    expect(() => uuidv7()).toThrow(/crypto\.getRandomValues/);
  });

  it('generates ids once the app supplies a random source', () => {
    const next = createUuidV7Generator({
      random: (bytes) => bytes.fill(0x5a),
    });
    expect(isUuidV7(next())).toBe(true);
  });
});
