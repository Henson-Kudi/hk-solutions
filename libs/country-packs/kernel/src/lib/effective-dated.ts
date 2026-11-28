import {
  DomainError,
  err,
  ok,
  parseLocalDate,
  type Result,
} from '@hk/platform/universal';

/**
 * Effective-dated values.
 *
 * A tax rate, a payroll rate or a threshold is never a constant in code. It
 * is a row in a table: the value, the day it starts to apply, and where the
 * number comes from. Asking the table for a date gives the value in force on
 * that day, so a document dated last year is still calculated with last
 * year's rate.
 *
 * Dates are calendar dates as "YYYY-MM-DD" strings, in the country's own
 * calendar. Rates are decimal strings ("0.05"), never JS numbers.
 */

/** Where a value comes from, and whether an accountant has confirmed it. */
export interface SourceNote {
  /** The law, circular or official publication: "Federal Decree-Law No. 8 of 2017, Art. 3". */
  readonly reference: string;
  readonly url?: string;
  /** Who confirmed the value for go-live. Absent means not yet confirmed. */
  readonly confirmedBy?: string;
  /** The day it was confirmed, "YYYY-MM-DD". */
  readonly confirmedOn?: string;
}

export interface EffectiveDated<Value> {
  /** First day the value applies. */
  readonly effectiveFrom: string;
  /**
   * Last day the value applies, inclusive. Leave it out and the value lasts
   * until the day before the next entry starts, or indefinitely for the last
   * entry. Set it to end a value with nothing replacing it.
   */
  readonly effectiveTo?: string;
  readonly value: Value;
  readonly source: SourceNote;
}

export interface RateTable<Value> {
  /** What the table holds: "vat.standard". Used in error details. */
  readonly key: string;
  /** In date order, oldest first. */
  readonly entries: readonly EffectiveDated<Value>[];
  /** The entry in force on `date`, or an error when none is. */
  at(date: string): Result<EffectiveDated<Value>>;
  /** The value in force on `date`. */
  valueAt(date: string): Result<Value>;
  /** Entries no accountant has confirmed yet. Must be empty before go-live. */
  unconfirmed(): readonly EffectiveDated<Value>[];
}

export const RATE_ERRORS = {
  /** The table itself is wrong: a programming error in a pack. */
  TABLE_INVALID: 'RATE_TABLE_INVALID',
  /** The date asked for is not a calendar date. */
  DATE_INVALID: 'RATE_DATE_INVALID',
  /** No entry covers the date: before the first entry, or in a gap. */
  NOT_IN_EFFECT: 'RATE_NOT_IN_EFFECT',
} as const;

const isDate = (value: unknown): value is string =>
  typeof value === 'string' && parseLocalDate(value).ok;

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Everything wrong with a source note. An empty list means it is usable. */
export const findSourceNoteIssues = (source: SourceNote): string[] => {
  const issues: string[] = [];
  if (typeof source !== 'object' || source === null) {
    return ['has no source note'];
  }
  if (!isFilled(source.reference)) {
    issues.push('source note has no reference');
  }
  if (source.url !== undefined && !/^https:\/\/\S+$/.test(source.url)) {
    issues.push('source url must start with https://');
  }
  const hasBy = source.confirmedBy !== undefined;
  const hasOn = source.confirmedOn !== undefined;
  if (hasBy !== hasOn) {
    issues.push('confirmedBy and confirmedOn go together');
  }
  if (hasBy && !isFilled(source.confirmedBy)) {
    issues.push('confirmedBy is empty');
  }
  if (hasOn && !isDate(source.confirmedOn)) {
    issues.push('confirmedOn is not a date');
  }
  return issues;
};

export const isConfirmed = (source: SourceNote): boolean =>
  isFilled(source.confirmedBy) && isDate(source.confirmedOn);

/**
 * Everything wrong with a table's entries. An empty list means the table is
 * valid: at least one entry, valid dates, a source for each, oldest first,
 * and no day covered twice.
 */
export const findRateTableIssues = <Value>(
  entries: readonly EffectiveDated<Value>[],
): string[] => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return ['has no entries'];
  }
  const issues: string[] = [];
  entries.forEach((entry, index) => {
    const where = `entry ${index + 1}`;
    if (!isDate(entry.effectiveFrom)) {
      issues.push(`${where}: effectiveFrom is not a date`);
      return;
    }
    if (entry.effectiveTo !== undefined) {
      if (!isDate(entry.effectiveTo)) {
        issues.push(`${where}: effectiveTo is not a date`);
        return;
      }
      if (entry.effectiveTo < entry.effectiveFrom) {
        issues.push(`${where}: ends before it starts`);
      }
    }
    if (entry.value === undefined || entry.value === null) {
      issues.push(`${where}: has no value`);
    }
    for (const issue of findSourceNoteIssues(entry.source)) {
      issues.push(`${where}: ${issue}`);
    }
    const previous = index > 0 ? entries[index - 1] : undefined;
    if (previous && isDate(previous.effectiveFrom)) {
      if (entry.effectiveFrom <= previous.effectiveFrom) {
        issues.push(`${where}: must start after the entry before it`);
      } else if (
        isDate(previous.effectiveTo) &&
        previous.effectiveTo >= entry.effectiveFrom
      ) {
        issues.push(`${where}: starts before the entry before it has ended`);
      }
    }
  });
  return issues;
};

const freezeEntry = <Value>(
  entry: EffectiveDated<Value>,
): EffectiveDated<Value> =>
  Object.freeze({ ...entry, source: Object.freeze({ ...entry.source }) });

/**
 * Builds a table. Throws when the entries are invalid, because a bad table is
 * a mistake in a pack, found when the pack loads and not when an invoice is
 * issued.
 */
export const createRateTable = <Value>(
  key: string,
  entries: readonly EffectiveDated<Value>[],
): RateTable<Value> => {
  const issues = isFilled(key)
    ? findRateTableIssues(entries)
    : ['the table has no key'];
  if (issues.length > 0) {
    throw new DomainError(
      RATE_ERRORS.TABLE_INVALID,
      `Rate table "${String(key)}" is invalid: ${issues.join('; ')}.`,
      { kind: 'invariant', details: { table: String(key) } },
    );
  }
  const frozen = Object.freeze(entries.map(freezeEntry));

  const at = (date: string): Result<EffectiveDated<Value>> => {
    if (!isDate(date)) {
      return err(
        new DomainError(
          RATE_ERRORS.DATE_INVALID,
          'A rate was asked for a value that is not a calendar date.',
          { details: { table: key } },
        ),
      );
    }
    // The last entry that has started by `date` is the only candidate: entries
    // are in order and do not overlap.
    let candidate: EffectiveDated<Value> | undefined;
    for (const entry of frozen) {
      if (entry.effectiveFrom > date) break;
      candidate = entry;
    }
    if (
      !candidate ||
      (candidate.effectiveTo !== undefined && candidate.effectiveTo < date)
    ) {
      return err(
        new DomainError(
          RATE_ERRORS.NOT_IN_EFFECT,
          'No value is in effect on that date.',
          { details: { table: key, date } },
        ),
      );
    }
    return ok(candidate);
  };

  return Object.freeze({
    key,
    entries: frozen,
    at,
    valueAt: (date: string): Result<Value> => {
      const found = at(date);
      return found.ok ? ok(found.value.value) : found;
    },
    unconfirmed: () => frozen.filter((entry) => !isConfirmed(entry.source)),
  });
};
