import { isDomainError } from '@hk/platform/universal';
import {
  RATE_ERRORS,
  createRateTable,
  findRateTableIssues,
  findSourceNoteIssues,
  isConfirmed,
  type EffectiveDated,
  type SourceNote,
} from './effective-dated';

const confirmed: SourceNote = {
  reference: 'Invented for tests',
  confirmedBy: 'an accountant',
  confirmedOn: '2026-01-01',
};
const unconfirmed: SourceNote = { reference: 'Invented for tests' };

const entry = (
  effectiveFrom: string,
  value: string,
  extra: Partial<EffectiveDated<string>> = {},
): EffectiveDated<string> => ({
  effectiveFrom,
  value,
  source: confirmed,
  ...extra,
});

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return isDomainError(error) ? error.code : String(error);
  }
  return undefined;
};

describe('rate tables', () => {
  const table = createRateTable('vat.standard', [
    entry('2018-01-01', '0.05'),
    entry('2024-07-01', '0.07'),
    entry('2026-01-01', '0.06', { effectiveTo: '2026-12-31' }),
  ]);

  it.each([
    ['2018-01-01', '0.05', 'the first day of the first entry'],
    ['2020-06-15', '0.05', 'the middle of the first entry'],
    ['2024-06-30', '0.05', 'the day before the rate changes'],
    ['2024-07-01', '0.07', 'the day the rate changes'],
    ['2025-12-31', '0.07', 'the last day of the second entry'],
    ['2026-01-01', '0.06', 'the first day of the last entry'],
    ['2026-12-31', '0.06', 'the last day of an entry that ends'],
  ])('on %s the value is %s (%s)', (date, expected) => {
    const found = table.valueAt(date);
    expect(found.ok && found.value).toBe(expected);
  });

  it('gives the whole entry, with its source', () => {
    const found = table.at('2024-08-01');
    expect(found.ok && found.value).toEqual({
      effectiveFrom: '2024-07-01',
      value: '0.07',
      source: confirmed,
    });
  });

  it.each([
    ['2017-12-31', 'the day before the first entry'],
    ['1900-01-01', 'long before the first entry'],
    ['2027-01-01', 'the day after the last entry ended'],
  ])('has no value on %s (%s)', (date) => {
    const found = table.valueAt(date);
    expect(found.ok).toBe(false);
    expect(!found.ok && found.error.code).toBe(RATE_ERRORS.NOT_IN_EFFECT);
    expect(!found.ok && found.error.details).toEqual({
      table: 'vat.standard',
      date,
    });
  });

  it('has no value in a gap between two entries', () => {
    const gapped = createRateTable('levy', [
      entry('2020-01-01', '0.01', { effectiveTo: '2020-12-31' }),
      entry('2022-01-01', '0.02'),
    ]);
    expect(gapped.valueAt('2020-12-31').ok).toBe(true);
    const inGap = gapped.valueAt('2021-06-01');
    expect(!inGap.ok && inGap.error.code).toBe(RATE_ERRORS.NOT_IN_EFFECT);
    expect(gapped.valueAt('2022-01-01').ok).toBe(true);
  });

  it('keeps the last entry in force indefinitely when it has no end', () => {
    const open = createRateTable('open', [entry('2020-01-01', '0.10')]);
    const found = open.valueAt('2999-12-31');
    expect(found.ok && found.value).toBe('0.10');
  });

  it.each(['', '2026-02-30', '2026-1-1', '01/02/2026', 'today'])(
    'refuses "%s" as a date',
    (date) => {
      const found = table.at(date);
      expect(!found.ok && found.error.code).toBe(RATE_ERRORS.DATE_INVALID);
    },
  );

  it('lists the entries no accountant has confirmed', () => {
    const mixed = createRateTable('mixed', [
      entry('2020-01-01', '0.01'),
      entry('2021-01-01', '0.02', { source: unconfirmed }),
    ]);
    expect(mixed.unconfirmed().map((item) => item.effectiveFrom)).toEqual([
      '2021-01-01',
    ]);
    expect(table.unconfirmed()).toEqual([]);
  });

  it('cannot be changed after it is built', () => {
    const entries = [entry('2020-01-01', '0.10')];
    const built = createRateTable('frozen', entries);
    entries.push(entry('2021-01-01', '0.99'));
    expect(built.entries).toHaveLength(1);
    expect(Object.isFrozen(built.entries)).toBe(true);
    expect(Object.isFrozen(built.entries[0])).toBe(true);
    expect(Object.isFrozen(built.entries[0]?.source)).toBe(true);
  });
});

describe('rate table validation', () => {
  it('accepts a table in date order with no day covered twice', () => {
    expect(
      findRateTableIssues([
        entry('2020-01-01', '0.01', { effectiveTo: '2020-12-31' }),
        entry('2021-01-01', '0.02'),
      ]),
    ).toEqual([]);
  });

  it.each<[string, EffectiveDated<string>[], string]>([
    ['no entries', [], 'has no entries'],
    [
      'an impossible start date',
      [entry('2020-02-30', '0.01')],
      'entry 1: effectiveFrom is not a date',
    ],
    [
      'an impossible end date',
      [entry('2020-01-01', '0.01', { effectiveTo: '2020-13-01' })],
      'entry 1: effectiveTo is not a date',
    ],
    [
      'an entry that ends before it starts',
      [entry('2020-06-01', '0.01', { effectiveTo: '2020-05-31' })],
      'entry 1: ends before it starts',
    ],
    [
      'entries out of order',
      [entry('2021-01-01', '0.02'), entry('2020-01-01', '0.01')],
      'entry 2: must start after the entry before it',
    ],
    [
      'two entries starting the same day',
      [entry('2020-01-01', '0.01'), entry('2020-01-01', '0.02')],
      'entry 2: must start after the entry before it',
    ],
    [
      'an entry starting before the previous one has ended',
      [
        entry('2020-01-01', '0.01', { effectiveTo: '2021-06-30' }),
        entry('2021-01-01', '0.02'),
      ],
      'entry 2: starts before the entry before it has ended',
    ],
    [
      'an entry starting on the day the previous one ends',
      [
        entry('2020-01-01', '0.01', { effectiveTo: '2021-01-01' }),
        entry('2021-01-01', '0.02'),
      ],
      'entry 2: starts before the entry before it has ended',
    ],
    [
      'a missing source reference',
      [entry('2020-01-01', '0.01', { source: { reference: ' ' } })],
      'entry 1: source note has no reference',
    ],
    [
      'a missing value',
      [entry('2020-01-01', undefined as unknown as string)],
      'entry 1: has no value',
    ],
  ])('reports %s', (_name, entries, expected) => {
    expect(findRateTableIssues(entries)).toContain(expected);
  });

  it('refuses to build an invalid table', () => {
    expect(codeOf(() => createRateTable('bad', []))).toBe(
      RATE_ERRORS.TABLE_INVALID,
    );
    expect(
      codeOf(() =>
        createRateTable('bad', [
          entry('2021-01-01', '0.02'),
          entry('2020-01-01', '0.01'),
        ]),
      ),
    ).toBe(RATE_ERRORS.TABLE_INVALID);
    expect(codeOf(() => createRateTable('', [entry('2020-01-01', '1')]))).toBe(
      RATE_ERRORS.TABLE_INVALID,
    );
  });
});

describe('source notes', () => {
  it('accepts a reference alone, and a confirmed note', () => {
    expect(findSourceNoteIssues(unconfirmed)).toEqual([]);
    expect(findSourceNoteIssues(confirmed)).toEqual([]);
    expect(
      findSourceNoteIssues({
        reference: 'A law',
        url: 'https://example.org/law',
      }),
    ).toEqual([]);
  });

  it.each<[string, SourceNote, string]>([
    ['no reference', { reference: '' }, 'source note has no reference'],
    [
      'a url that is not https',
      { reference: 'A law', url: 'http://example.org' },
      'source url must start with https://',
    ],
    [
      'a confirmer without a date',
      { reference: 'A law', confirmedBy: 'someone' },
      'confirmedBy and confirmedOn go together',
    ],
    [
      'a date without a confirmer',
      { reference: 'A law', confirmedOn: '2026-01-01' },
      'confirmedBy and confirmedOn go together',
    ],
    [
      'an impossible confirmation date',
      { reference: 'A law', confirmedBy: 'someone', confirmedOn: '2026-02-31' },
      'confirmedOn is not a date',
    ],
    [
      'an empty confirmer',
      { reference: 'A law', confirmedBy: ' ', confirmedOn: '2026-01-01' },
      'confirmedBy is empty',
    ],
  ])('reports %s', (_name, source, expected) => {
    expect(findSourceNoteIssues(source)).toContain(expected);
  });

  it('counts a note as confirmed only with a name and a date', () => {
    expect(isConfirmed(confirmed)).toBe(true);
    expect(isConfirmed(unconfirmed)).toBe(false);
    expect(isConfirmed({ reference: 'A law', confirmedBy: 'someone' })).toBe(
      false,
    );
  });
});
