import { DomainError, err, ok, type Result } from '@hk/platform/universal';
import type { CountryCode } from './country';
import type { CountryPack } from './country-pack';
import { findPackIssues } from './validation';

/**
 * The packs a running app has.
 *
 * The kernel cannot import the packs (they import it), so whoever starts the
 * app builds the registry: `createPackRegistry([cmPack, aePack])`. Code that
 * needs a pack is handed the registry and asks it by the business's country.
 */
export interface PackRegistry {
  codes(): readonly CountryCode[];
  all(): readonly CountryPack[];
  has(code: string): boolean;
  /** For a code that comes from outside: a request, a stored business. */
  find(code: string): Result<CountryPack>;
  /** For a code the caller already trusts. Throws when there is no such pack. */
  get(code: CountryCode): CountryPack;
}

export const PACK_ERRORS = {
  /** A pack failed validation when the registry was built. */
  INVALID: 'COUNTRY_PACK_INVALID',
  /** Two packs claim the same country. */
  DUPLICATE: 'COUNTRY_PACK_DUPLICATE',
  /** No pack for that country. */
  NOT_SUPPORTED: 'COUNTRY_NOT_SUPPORTED',
} as const;

const MAX_ISSUES_IN_MESSAGE = 5;

/**
 * Builds the registry. Throws when a pack is invalid or a country appears
 * twice, so a broken pack stops the app at start-up and not at the first
 * invoice.
 */
export const createPackRegistry = (
  packs: readonly CountryPack[],
): PackRegistry => {
  const byCode = new Map<string, CountryPack>();
  for (const pack of packs) {
    const issues = findPackIssues(pack);
    if (issues.length > 0) {
      const shown = issues
        .slice(0, MAX_ISSUES_IN_MESSAGE)
        .map((issue) => `${issue.area}: ${issue.message}`)
        .join('; ');
      throw new DomainError(
        PACK_ERRORS.INVALID,
        `Country pack "${String(pack.code)}" is invalid (${issues.length} issue(s)): ${shown}.`,
        {
          kind: 'invariant',
          details: { country: String(pack.code), issues: issues.length },
        },
      );
    }
    if (byCode.has(pack.code)) {
      throw new DomainError(
        PACK_ERRORS.DUPLICATE,
        `Country pack "${pack.code}" is registered twice.`,
        { kind: 'invariant', details: { country: pack.code } },
      );
    }
    byCode.set(pack.code, pack);
  }
  const all = Object.freeze([...byCode.values()]);
  const codes = Object.freeze(all.map((pack) => pack.code));

  const find = (code: string): Result<CountryPack> => {
    const pack = typeof code === 'string' ? byCode.get(code) : undefined;
    return pack
      ? ok(pack)
      : err(
          new DomainError(
            PACK_ERRORS.NOT_SUPPORTED,
            'That country is not supported.',
            { kind: 'not-found' },
          ),
        );
  };

  return Object.freeze({
    codes: () => codes,
    all: () => all,
    has: (code: string) => byCode.has(code),
    find,
    get: (code: CountryCode): CountryPack => {
      const found = find(code);
      if (!found.ok) {
        throw found.error;
      }
      return found.value;
    },
  });
};
