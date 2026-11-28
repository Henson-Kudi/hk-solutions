import { DomainError, Money, err, ok } from '@hk/platform/universal';
import {
  createFixturePack,
  createFixtureSubject,
  fixtureCalculate,
  fixtureManifest,
  fixtureTaxIdValidator,
} from '../testing/fixture-pack';
import { brokenPack, pick, type Draft } from '../testing/mutate';
import {
  countryPackConformance,
  type PackConformanceSubject,
} from './conformance';
import type { TaxCalculation, TaxLineResult, TaxRequest } from './country-pack';
import { createRateTable } from './effective-dated';
import { PACK_AREAS } from './validation';

/** Names of the conformance cases the subject fails. */
const failures = async (subject: PackConformanceSubject): Promise<string[]> => {
  const failed: string[] = [];
  for (const testCase of countryPackConformance) {
    try {
      await testCase.run(subject);
    } catch {
      failed.push(testCase.name);
    }
  }
  return failed;
};

const source = {
  reference: 'Invented for tests',
  confirmedBy: 'kernel tests',
  confirmedOn: '2020-01-01',
};

/** Wraps the fixture's engine and changes what it returns. */
const withResult =
  (change: (result: TaxCalculation, request: TaxRequest) => TaxCalculation) =>
  (draft: Draft): void => {
    const calculate = fixtureCalculate(draft.tax.codes);
    draft.tax.calculate = (request) => {
      const result = calculate(request);
      return result.ok ? ok(change(result.value, request)) : result;
    };
  };

const mapLines = (
  result: TaxCalculation,
  change: (line: TaxLineResult) => TaxLineResult,
): TaxCalculation => ({ ...result, lines: result.lines.map(change) });

const AMOUNTS = 'tax: every code calculates, and the amounts add up';

describe('pack conformance suite', () => {
  // This is how a pack uses the suite.
  describe('run against the fixture pack', () => {
    const subject = createFixtureSubject();
    for (const testCase of countryPackConformance) {
      it(testCase.name, () => testCase.run(subject));
    }
  });

  it('has one structure case per area of a pack, and no name twice', () => {
    const names = countryPackConformance.map((testCase) => testCase.name);
    expect(new Set(names).size).toBe(names.length);
    for (const area of PACK_AREAS) {
      expect(names).toContain(`is well formed: ${area}`);
    }
  });

  it('passes with product manifests the pack can carry', async () => {
    expect(
      await failures({
        ...createFixtureSubject(),
        manifests: [fixtureManifest()],
      }),
    ).toEqual([]);
  });

  // Each row breaks the pack in one way. The suite is only worth having if
  // the right case notices.
  describe('notices a pack that', () => {
    it.each<[string, (draft: Draft) => void, string[]]>([
      [
        'is malformed in one area',
        (d) => {
          d.fiscal.defaultYearStartMonth = 0;
        },
        [
          'is well formed: fiscal',
          'can be registered and found by its country',
        ],
      ],
      [
        'accepts any tax id',
        (d) => {
          d.business.taxIdValidator = (value) => ok(value.trim());
        },
        ['tax id: rejects invalid numbers without quoting them'],
      ],
      [
        'rejects every tax id',
        (d) => {
          d.business.taxIdValidator = () =>
            err(new DomainError('TAX_ID_INVALID', 'Not valid.'));
        },
        ['tax id: accepts valid numbers and returns them in canonical form'],
      ],
      [
        'does not trim a tax id',
        (d) => {
          d.business.taxIdValidator = (value) =>
            /^FX\d{6}$/.test(value)
              ? ok(value)
              : err(new DomainError('TAX_ID_INVALID', 'Not valid.'));
        },
        ['tax id: accepts valid numbers and returns them in canonical form'],
      ],
      [
        'quotes the tax id in its error message',
        (d) => {
          d.business.taxIdValidator = (value) => {
            const result = fixtureTaxIdValidator(value);
            return result.ok
              ? result
              : err(
                  new DomainError('TAX_ID_INVALID', `"${value}" is not valid.`),
                );
          };
        },
        ['tax id: rejects invalid numbers without quoting them'],
      ],
      [
        'puts the tax id in its error details',
        (d) => {
          d.business.taxIdValidator = (value) => {
            const result = fixtureTaxIdValidator(value);
            return result.ok
              ? result
              : err(
                  new DomainError('TAX_ID_INVALID', 'Not valid.', {
                    details: { value },
                  }),
                );
          };
        },
        ['tax id: rejects invalid numbers without quoting them'],
      ],
      [
        'has a registration field validator that throws',
        (d) => {
          pick(d.business.registrationFields, 0).validate = () => {
            throw new Error('boom');
          };
        },
        ['registration fields: validators answer without throwing'],
      ],
      [
        'lists a rate that has ended',
        (d) => {
          const std = pick(d.tax.codes, 0);
          pick(std.components, 0).rate = createRateTable('ended', [
            {
              effectiveFrom: '2010-01-01',
              effectiveTo: '2019-12-31',
              value: '0.08',
              source,
            },
          ]);
          d.tax.calculate = fixtureCalculate(d.tax.codes);
        },
        [
          'tax: every rate is in force on the reference date',
          AMOUNTS,
          'tax: nothing is charged on a zero amount',
          'tax: totals are the sums of the lines',
          'tax: the same request gives the same answer',
          'tax: the default codes exist and calculate',
        ],
      ],
      [
        'does not round tax to the currency',
        withResult((result) =>
          mapLines(result, (line) => {
            const extra = Money.of('0.4', line.net.currency);
            const components = line.components.map((component, index) =>
              index === 0
                ? { ...component, amount: component.amount.plus(extra) }
                : component,
            );
            return components.length === 0
              ? line
              : {
                  ...line,
                  components,
                  tax: line.tax.plus(extra),
                  gross: line.gross.plus(extra),
                };
          }),
        ),
        [
          AMOUNTS,
          'tax: zero-rated, exempt and out-of-scope codes charge nothing',
          'tax: nothing is charged on a zero amount',
          'tax: totals are the sums of the lines',
        ],
      ],
      [
        'reports a line tax that is not the sum of its components',
        withResult((result) =>
          mapLines(result, (line) => ({
            ...line,
            tax: line.tax.plus(Money.of('1', line.net.currency)),
          })),
        ),
        [
          AMOUNTS,
          'tax: zero-rated, exempt and out-of-scope codes charge nothing',
          'tax: nothing is charged on a zero amount',
          'tax: totals are the sums of the lines',
        ],
      ],
      [
        'reports a gross that is not net plus tax',
        withResult((result) =>
          mapLines(result, (line) => ({
            ...line,
            gross: line.gross.plus(Money.of('5', line.net.currency)),
          })),
        ),
        [
          AMOUNTS,
          'tax: zero-rated, exempt and out-of-scope codes charge nothing',
          'tax: nothing is charged on a zero amount',
          'tax: totals are the sums of the lines',
        ],
      ],
      [
        'reports a rate other than the one in force',
        withResult((result) =>
          mapLines(result, (line) => ({
            ...line,
            components: line.components.map((component) => ({
              ...component,
              rate: '0.99',
            })),
          })),
        ),
        [AMOUNTS],
      ],
      [
        'reports the output role on a purchase',
        (d) => {
          const calculate = fixtureCalculate(d.tax.codes);
          d.tax.calculate = (request) =>
            calculate({ ...request, direction: 'sale' });
        },
        [AMOUNTS],
      ],
      [
        'changes the net amount',
        withResult((result) =>
          mapLines(result, (line) => ({
            ...line,
            net: line.net
              .roundToMinorUnit()
              .plus(Money.of('1', line.net.currency)),
          })),
        ),
        [
          AMOUNTS,
          'tax: zero-rated, exempt and out-of-scope codes charge nothing',
          'tax: totals are the sums of the lines',
        ],
      ],
      [
        'returns totals that are not the sums of the lines',
        withResult((result) => ({
          ...result,
          totalTax:
            result.lines.length > 1
              ? result.totalTax.plus(Money.of('1', result.totalTax.currency))
              : result.totalTax,
        })),
        ['tax: totals are the sums of the lines'],
      ],
      [
        'returns lines in a different order',
        withResult((result) => ({
          ...result,
          lines: [...result.lines].reverse(),
        })),
        ['tax: totals are the sums of the lines'],
      ],
      [
        'charges tax on an exempt code',
        withResult((result) =>
          mapLines(result, (line) =>
            line.taxCode === 'EXEMPT'
              ? {
                  ...line,
                  tax: Money.of('50', line.net.currency),
                  gross: line.net.plus(Money.of('50', line.net.currency)),
                }
              : line,
          ),
        ),
        [
          AMOUNTS,
          'tax: zero-rated, exempt and out-of-scope codes charge nothing',
          'tax: nothing is charged on a zero amount',
          'tax: totals are the sums of the lines',
        ],
      ],
      [
        'charges a fixed fee on a zero amount',
        withResult((result) =>
          mapLines(result, (line) =>
            line.net.isZero() && line.taxCode === 'STD'
              ? { ...line, gross: Money.of('10', line.net.currency) }
              : line,
          ),
        ),
        ['tax: nothing is charged on a zero amount'],
      ],
      [
        'gives a different answer the second time',
        (d) => {
          const calculate = fixtureCalculate(d.tax.codes);
          let calls = 0;
          d.tax.calculate = (request) => {
            const result = calculate(request);
            calls += 1;
            if (!result.ok || calls % 2 === 1) return result;
            return ok({
              ...result.value,
              totalGross: result.value.totalGross.plus(
                Money.of('1', result.value.totalGross.currency),
              ),
            });
          };
        },
        // The engine alternates, so which other cases see the wrong total
        // depends on call order. The repeat case always does.
        ['tax: the same request gives the same answer'],
      ],
      [
        'treats an unknown tax code as untaxed',
        (d) => {
          const calculate = fixtureCalculate(d.tax.codes);
          d.tax.calculate = (request) =>
            calculate({
              ...request,
              lines: request.lines.map((line) =>
                line.taxCode === 'NO_SUCH_CODE'
                  ? { ...line, taxCode: 'EXEMPT' }
                  : line,
              ),
            });
        },
        ['tax: an unknown code is refused'],
      ],
      [
        'adds up lines in different currencies',
        (d) => {
          const calculate = fixtureCalculate(d.tax.codes);
          d.tax.calculate = (request) =>
            calculate({
              ...request,
              lines: request.lines.map((line) => ({
                ...line,
                net: Money.of(line.net.amount, 'XAF'),
              })),
            });
        },
        ['tax: lines in different currencies are refused'],
      ],
      [
        "uses today's rate for a date before the tax existed",
        (d) => {
          const calculate = fixtureCalculate(d.tax.codes);
          d.tax.calculate = (request) =>
            calculate({ ...request, date: '2026-01-15' });
        },
        ['tax: a date before any rate is refused, not guessed'],
      ],
    ])('%s', async (_name, change, expected) => {
      const failed = await failures(createFixtureSubject(brokenPack(change)));
      if (_name === 'gives a different answer the second time') {
        expect(failed).toEqual(expect.arrayContaining(expected));
      } else {
        expect(failed).toEqual(expected);
      }
    });

    it('offers a product whose required capability the country lacks', async () => {
      expect(
        await failures({
          ...createFixtureSubject(),
          manifests: [
            fixtureManifest({ requiresCapabilities: ['einvoicing.fta'] }),
          ],
        }),
      ).toEqual(['carries every product it offers']);
    });
  });

  describe('notices a subject that', () => {
    it('gives no tax id samples', async () => {
      expect(
        await failures({
          ...createFixtureSubject(),
          samples: { validTaxIds: [], invalidTaxIds: [] },
        }),
      ).toEqual([
        'tax id: accepts valid numbers and returns them in canonical form',
        'tax id: rejects invalid numbers without quoting them',
      ]);
    });

    it('names a reference date on which a rate is not in force', async () => {
      const failed = await failures({
        ...createFixtureSubject(createFixturePack()),
        asOf: '2005-06-01',
      });
      expect(failed).toContain(
        'tax: every rate is in force on the reference date',
      );
    });
  });
});
