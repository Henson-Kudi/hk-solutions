import { DomainError } from './domain-error';
import {
  addDays,
  addMonths,
  compareLocalDates,
  daysBetween,
  daysInMonth,
  endOfMonth,
  isLeapYear,
  isWithinRange,
  localDate,
  localDateOf,
  localDateParts,
  parseLocalDate,
  startOfMonth,
  toLocalDate,
} from './local-date';

const code = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'NOT_A_DOMAIN_ERROR';
  }
  return 'DID_NOT_THROW';
};

describe('LocalDate', () => {
  describe('parsing', () => {
    it.each([
      '2026-11-27',
      '2024-02-29',
      '2000-02-29',
      '0001-01-01',
      '9999-12-31',
    ])('accepts %s', (input) => {
      expect(parseLocalDate(input).ok).toBe(true);
    });

    it.each([
      '2026-02-29',
      '1900-02-29',
      '2026-02-30',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '0000-01-01',
      '2026-1-5',
      '26-01-05',
      '2026/01/05',
      '2026-01-05T00:00:00Z',
      ' 2026-01-05',
      '',
    ])('rejects %p', (input) => {
      const result = parseLocalDate(input);
      expect(!result.ok && result.error.code).toBe('DATE_INVALID');
    });

    it('builds from and splits into parts', () => {
      expect(localDateOf(2026, 3, 9)).toBe('2026-03-09');
      expect(localDateParts(localDate('2026-03-09'))).toEqual({
        year: 2026,
        month: 3,
        day: 9,
      });
      expect(code(() => localDateOf(2026, 2, 30))).toBe('DATE_INVALID');
      expect(code(() => localDate('yesterday'))).toBe('DATE_INVALID');
    });
  });

  describe('calendar', () => {
    it('knows leap years, including the century rule', () => {
      expect(isLeapYear(2024)).toBe(true);
      expect(isLeapYear(2026)).toBe(false);
      expect(isLeapYear(1900)).toBe(false);
      expect(isLeapYear(2000)).toBe(true);
    });

    it('knows month lengths', () => {
      expect(daysInMonth(2026, 2)).toBe(28);
      expect(daysInMonth(2024, 2)).toBe(29);
      expect(daysInMonth(2026, 4)).toBe(30);
      expect(daysInMonth(2026, 12)).toBe(31);
    });

    it('finds the first and last day of a month', () => {
      expect(startOfMonth(localDate('2026-02-17'))).toBe('2026-02-01');
      expect(endOfMonth(localDate('2026-02-17'))).toBe('2026-02-28');
      expect(endOfMonth(localDate('2024-02-01'))).toBe('2024-02-29');
      expect(endOfMonth(localDate('2026-12-05'))).toBe('2026-12-31');
    });
  });

  describe('arithmetic', () => {
    it('adds days across month, year and leap-day boundaries', () => {
      expect(addDays(localDate('2026-12-31'), 1)).toBe('2027-01-01');
      expect(addDays(localDate('2027-01-01'), -1)).toBe('2026-12-31');
      expect(addDays(localDate('2024-02-28'), 1)).toBe('2024-02-29');
      expect(addDays(localDate('2026-02-28'), 1)).toBe('2026-03-01');
      expect(addDays(localDate('2026-01-15'), 30)).toBe('2026-02-14');
      expect(addDays(localDate('2026-01-15'), 0)).toBe('2026-01-15');
    });

    it('agrees with the platform calendar for every day of 40 years', () => {
      const start = Date.UTC(1999, 11, 25);
      let date = localDate('1999-12-25');
      for (let offset = 0; offset < 14610; offset += 1) {
        const expected = new Date(start + offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        expect(date).toBe(expected);
        date = addDays(date, 1);
      }
    });

    it('adds months, clamping to the end of a shorter month', () => {
      expect(addMonths(localDate('2026-01-31'), 1)).toBe('2026-02-28');
      expect(addMonths(localDate('2024-01-31'), 1)).toBe('2024-02-29');
      expect(addMonths(localDate('2026-03-31'), -1)).toBe('2026-02-28');
      expect(addMonths(localDate('2026-11-15'), 2)).toBe('2027-01-15');
      expect(addMonths(localDate('2026-01-15'), -1)).toBe('2025-12-15');
      expect(addMonths(localDate('2026-05-31'), 12)).toBe('2027-05-31');
      expect(addMonths(localDate('2024-02-29'), 12)).toBe('2025-02-28');
    });

    it('counts the days between two dates', () => {
      expect(
        daysBetween(localDate('2026-01-01'), localDate('2026-12-31')),
      ).toBe(364);
      expect(
        daysBetween(localDate('2024-01-01'), localDate('2024-12-31')),
      ).toBe(365);
      expect(
        daysBetween(localDate('2026-03-01'), localDate('2026-02-01')),
      ).toBe(-28);
      expect(
        daysBetween(localDate('1970-01-01'), localDate('2026-11-27')),
      ).toBe(Date.UTC(2026, 10, 27) / 86_400_000);
    });

    it('refuses fractions and results outside years 0001 to 9999', () => {
      expect(code(() => addDays(localDate('2026-01-01'), 1.5))).toBe(
        'DATE_AMOUNT_INVALID',
      );
      expect(code(() => addMonths(localDate('2026-01-01'), Number.NaN))).toBe(
        'DATE_AMOUNT_INVALID',
      );
      expect(code(() => addDays(localDate('9999-12-31'), 1))).toBe(
        'DATE_OUT_OF_RANGE',
      );
      expect(code(() => addDays(localDate('0001-01-01'), -1))).toBe(
        'DATE_OUT_OF_RANGE',
      );
      expect(code(() => addMonths(localDate('9999-12-31'), 1))).toBe(
        'DATE_OUT_OF_RANGE',
      );
    });
  });

  describe('comparison', () => {
    it('compares in calendar order', () => {
      expect(
        compareLocalDates(localDate('2026-01-31'), localDate('2026-02-01')),
      ).toBe(-1);
      expect(
        compareLocalDates(localDate('2026-02-01'), localDate('2026-01-31')),
      ).toBe(1);
      expect(
        compareLocalDates(localDate('2026-02-01'), localDate('2026-02-01')),
      ).toBe(0);
    });

    it('checks an effective-date range, inclusive at both ends', () => {
      const from = localDate('2026-01-01');
      const to = localDate('2026-12-31');
      expect(isWithinRange(localDate('2026-01-01'), from, to)).toBe(true);
      expect(isWithinRange(localDate('2026-12-31'), from, to)).toBe(true);
      expect(isWithinRange(localDate('2025-12-31'), from, to)).toBe(false);
      expect(isWithinRange(localDate('2027-01-01'), from, to)).toBe(false);
      expect(isWithinRange(localDate('2031-06-01'), from, null)).toBe(true);
      expect(isWithinRange(localDate('2025-06-01'), from, null)).toBe(false);
    });
  });

  describe('time zones', () => {
    it('gives the business date of an instant', () => {
      const lateOnNewYearsEve = new Date('2026-12-31T23:30:00Z');
      expect(toLocalDate(lateOnNewYearsEve, 'UTC')).toBe('2026-12-31');
      expect(toLocalDate(lateOnNewYearsEve, 'Africa/Douala')).toBe(
        '2027-01-01',
      );
      expect(toLocalDate(lateOnNewYearsEve, 'Asia/Dubai')).toBe('2027-01-01');
      expect(toLocalDate(lateOnNewYearsEve, 'America/New_York')).toBe(
        '2026-12-31',
      );
    });

    it('handles the hour before midnight in each launch market', () => {
      // Douala is UTC+1 and Dubai is UTC+4, neither with daylight saving.
      expect(
        toLocalDate(new Date('2026-06-30T22:59:59Z'), 'Africa/Douala'),
      ).toBe('2026-06-30');
      expect(
        toLocalDate(new Date('2026-06-30T23:00:00Z'), 'Africa/Douala'),
      ).toBe('2026-07-01');
      expect(toLocalDate(new Date('2026-06-30T19:59:59Z'), 'Asia/Dubai')).toBe(
        '2026-06-30',
      );
      expect(toLocalDate(new Date('2026-06-30T20:00:00Z'), 'Asia/Dubai')).toBe(
        '2026-07-01',
      );
    });

    it('refuses an unknown time zone or an invalid instant', () => {
      expect(code(() => toLocalDate(new Date(0), 'Mars/Olympus'))).toBe(
        'DATE_TIME_ZONE_INVALID',
      );
      expect(code(() => toLocalDate(new Date('nope'), 'UTC'))).toBe(
        'DATE_INVALID',
      );
    });
  });
});
