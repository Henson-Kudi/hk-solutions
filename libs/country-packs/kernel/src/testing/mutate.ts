import type { CountryPack } from '../lib/country-pack';
import type { RateTable } from '../lib/effective-dated';
import { createFixturePack } from './fixture-pack';

/**
 * The same type with `readonly` removed, so a test can break one thing. Rate
 * tables stay as they are: they are frozen, and a test replaces a whole table.
 */
export type Mutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends RegExp | RateTable<unknown>
    ? T
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

export type Draft = Mutable<CountryPack>;

/** A fresh fixture pack with one change applied. */
export const brokenPack = (change: (draft: Draft) => void): CountryPack => {
  const draft = createFixturePack() as Draft;
  change(draft);
  return draft as CountryPack;
};

/** Element `index` of a list, or a failure that names what was missing. */
export const pick = <T>(list: T[], index: number): T => {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`fixture has no element ${index}`);
  }
  return item;
};
