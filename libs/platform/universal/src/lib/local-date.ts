import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

/**
 * A calendar date with no time and no time zone, written YYYY-MM-DD.
 *
 * Posting dates, due dates, fiscal periods and the effective dates of tax
 * rates are all LocalDates. Because the value is a plain string in ISO order,
 * it sorts correctly, survives JSON unchanged and never shifts by a day when
 * it crosses a time zone.
 *
 * All arithmetic here is integer maths on the proleptic Gregorian calendar.
 * It does not use Date, so it behaves identically on every runtime.
 */
export type LocalDate = string & { readonly __brand: 'LocalDate' };

export interface LocalDateParts {
  year: number;
  /** 1 to 12. */
  month: number;
  /** 1 to 31. */
  day: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

export const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

const isValid = ({ year, month, day }: LocalDateParts): boolean =>
  Number.isInteger(year) &&
  Number.isInteger(month) &&
  Number.isInteger(day) &&
  year >= MIN_YEAR &&
  year <= MAX_YEAR &&
  month >= 1 &&
  month <= 12 &&
  day >= 1 &&
  day <= daysInMonth(year, month);

const pad = (value: number, length: number): string =>
  String(value).padStart(length, '0');

const invalid = (): DomainError =>
  new DomainError(
    'DATE_INVALID',
    'Date must be a real calendar date written YYYY-MM-DD.',
  );

const outOfRange = (): DomainError =>
  new DomainError(
    'DATE_OUT_OF_RANGE',
    'Date arithmetic left the supported range of years 0001 to 9999.',
    { kind: 'invariant' },
  );

const fromParts = (parts: LocalDateParts): LocalDate => {
  if (!isValid(parts)) {
    throw outOfRange();
  }
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}` as LocalDate;
};

/** For input the caller has to validate. Rejects impossible dates such as 2026-02-30. */
export const parseLocalDate = (input: string): Result<LocalDate> => {
  const match = typeof input === 'string' ? ISO_DATE.exec(input) : null;
  if (!match) {
    return err(invalid());
  }
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  return isValid(parts) ? ok(input as LocalDate) : err(invalid());
};

/** For values the code already trusts. Throws a DomainError on anything else. */
export const localDate = (input: string): LocalDate => {
  const parsed = parseLocalDate(input);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
};

export const localDateOf = (
  year: number,
  month: number,
  day: number,
): LocalDate => {
  const parts = { year, month, day };
  if (!isValid(parts)) {
    throw invalid();
  }
  return fromParts(parts);
};

export const localDateParts = (date: LocalDate): LocalDateParts => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(5, 7)),
  day: Number(date.slice(8, 10)),
});

/** Days since 1970-01-01. Algorithm: Howard Hinnant, "days_from_civil". */
const toEpochDay = ({ year, month, day }: LocalDateParts): number => {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear =
    Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
};

/** The inverse of toEpochDay. Algorithm: Howard Hinnant, "civil_from_days". */
const fromEpochDay = (epochDay: number): LocalDateParts => {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
};

const assertInteger = (value: number): void => {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(
      'DATE_AMOUNT_INVALID',
      'Days and months to add must be whole numbers.',
      { kind: 'invariant' },
    );
  }
};

export const addDays = (date: LocalDate, days: number): LocalDate => {
  assertInteger(days);
  return fromParts(fromEpochDay(toEpochDay(localDateParts(date)) + days));
};

/**
 * Adds calendar months. When the target month is shorter, the day is clamped
 * to its last day: 31 January plus one month is 28 (or 29) February.
 */
export const addMonths = (date: LocalDate, months: number): LocalDate => {
  assertInteger(months);
  const { year, month, day } = localDateParts(date);
  const monthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex - targetYear * 12 + 1;
  if (targetYear < MIN_YEAR || targetYear > MAX_YEAR) {
    throw outOfRange();
  }
  return fromParts({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  });
};

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export const daysBetween = (from: LocalDate, to: LocalDate): number =>
  toEpochDay(localDateParts(to)) - toEpochDay(localDateParts(from));

export const compareLocalDates = (a: LocalDate, b: LocalDate): -1 | 0 | 1 =>
  a < b ? -1 : a > b ? 1 : 0;

export const startOfMonth = (date: LocalDate): LocalDate =>
  fromParts({ ...localDateParts(date), day: 1 });

export const endOfMonth = (date: LocalDate): LocalDate => {
  const { year, month } = localDateParts(date);
  return fromParts({ year, month, day: daysInMonth(year, month) });
};

/**
 * True when `date` is on or after `from` and on or before `to`. Pass null for
 * `to` when the range is open-ended, as with a tax rate that is still in force.
 */
export const isWithinRange = (
  date: LocalDate,
  from: LocalDate,
  to: LocalDate | null,
): boolean => date >= from && (to === null || date <= to);

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone);
  if (cached) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch (cause) {
    throw new DomainError(
      'DATE_TIME_ZONE_INVALID',
      'Time zone must be an IANA name such as Africa/Douala or Asia/Dubai.',
      { cause },
    );
  }
  formatters.set(timeZone, formatter);
  return formatter;
};

/**
 * The calendar date of an instant, as seen in an IANA time zone. This is how a
 * business gets "today": 23:30 UTC on 31 December is already 1 January in
 * Douala and in Dubai.
 */
export const toLocalDate = (instant: Date, timeZone: string): LocalDate => {
  if (Number.isNaN(instant.getTime())) {
    throw invalid();
  }
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return localDateOf(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
  );
};
