import { isDomainError } from '@hk/platform/universal';
import { createFixturePack } from '../testing/fixture-pack';
import { brokenPack } from '../testing/mutate';
import { PACK_ERRORS, createPackRegistry } from './registry';

const thrownBy = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('nothing was thrown');
};

describe('pack registry', () => {
  const cm = createFixturePack();
  const ae = brokenPack((draft) => {
    draft.code = 'AE';
    draft.locales = ['en-AE'];
  });

  it('finds a pack by its country', () => {
    const registry = createPackRegistry([cm, ae]);
    expect(registry.codes()).toEqual(['CM', 'AE']);
    expect(registry.all()).toEqual([cm, ae]);
    expect(registry.get('AE')).toBe(ae);
    const found = registry.find('CM');
    expect(found.ok && found.value).toBe(cm);
    expect(registry.has('CM')).toBe(true);
  });

  it('answers "not supported" for a country without a pack', () => {
    const registry = createPackRegistry([cm]);
    expect(registry.has('AE')).toBe(false);
    for (const code of ['AE', 'FR', 'cm', '', 'constructor']) {
      const found = registry.find(code);
      expect(!found.ok && found.error.code).toBe(PACK_ERRORS.NOT_SUPPORTED);
      expect(!found.ok && found.error.kind).toBe('not-found');
    }
    expect(thrownBy(() => registry.get('AE')).code).toBe(
      PACK_ERRORS.NOT_SUPPORTED,
    );
  });

  it('does not say which country was asked for in the error', () => {
    // The code comes from a request. It is not echoed back.
    const found = createPackRegistry([cm]).find('<script>');
    expect(!found.ok && found.error.message).toBe(
      'That country is not supported.',
    );
    expect(!found.ok && found.error.details).toEqual({});
  });

  it('refuses the same country twice', () => {
    const error = thrownBy(() => createPackRegistry([cm, createFixturePack()]));
    expect(error.code).toBe(PACK_ERRORS.DUPLICATE);
    expect(error.kind).toBe('invariant');
  });

  it('refuses an invalid pack, and says what is wrong with it', () => {
    const invalid = brokenPack((draft) => {
      draft.fiscal.defaultYearStartMonth = 0;
      draft.tax.defaultSaleCode = 'NOPE';
    });
    const error = thrownBy(() => createPackRegistry([cm, invalid]));
    expect(error.code).toBe(PACK_ERRORS.INVALID);
    expect(error.kind).toBe('invariant');
    expect(error.details).toEqual({ country: 'CM', issues: 2 });
    expect(error.message).toContain('defaultYearStartMonth must be 1 to 12');
    expect(error.message).toContain('defaultSaleCode is not one of the codes');
  });

  it('cannot be changed after it is built', () => {
    const packs = [cm];
    const registry = createPackRegistry(packs);
    packs.push(ae);
    expect(registry.codes()).toEqual(['CM']);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.all())).toBe(true);
  });

  it('can be empty', () => {
    const registry = createPackRegistry([]);
    expect(registry.codes()).toEqual([]);
    expect(registry.find('CM').ok).toBe(false);
  });
});
