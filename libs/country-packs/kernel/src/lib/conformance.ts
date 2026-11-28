import type { ProductManifest } from '@hk/contracts/product-manifest';
import {
  ConformanceFailure,
  expectEqual,
  expectTrue,
  type ConformanceCase,
} from '@hk/platform/test-kit';
import { Money, type Result } from '@hk/platform/universal';
import {
  TAX_ERRORS,
  UNTAXED_TREATMENTS,
  type CountryPack,
  type TaxCalculation,
  type TaxCodeDef,
  type TaxRequest,
} from './country-pack';
import { RATE_ERRORS } from './effective-dated';
import { createPackRegistry } from './registry';
import {
  PACK_AREAS,
  findPackIssues,
  findPackManifestIssues,
} from './validation';

/**
 * The pack conformance suite: what every country pack must do, whatever the
 * country.
 *
 * Each pack's test file runs it against its own pack:
 *
 *   describe('cm pack', () => {
 *     for (const testCase of countryPackConformance) {
 *       it(testCase.name, () => testCase.run(subject));
 *     }
 *   });
 *
 * It checks shape and behaviour: the parts refer to each other correctly, the
 * validators hold, and the tax engine's arithmetic adds up. It cannot check
 * that a rate is the right rate. Test vectors reviewed by an accountant do
 * that, in each pack.
 */
export interface PackConformanceSubject {
  pack: CountryPack;
  /** A day on which every rate in the pack is in force, "YYYY-MM-DD". */
  asOf: string;
  samples: {
    /** At least one tax registration number of the right shape. Invented, never a real one. */
    validTaxIds: readonly string[];
    /** At least one that must be rejected. */
    invalidTaxIds: readonly string[];
  };
  /** Every product manifest, once products exist. */
  manifests?: readonly ProductManifest[];
}

type Case = ConformanceCase<PackConformanceSubject>;

/** A date before any tax in any pack: no rate is in force. */
const BEFORE_ALL_RATES = '1900-01-01';
const SAMPLE_NET = '1000';

const sameMoney = (a: Money, b: Money): boolean =>
  a.currency === b.currency && a.amount.equals(b.amount);

const expectMoney = (actual: Money, expected: Money, what: string): void => {
  if (!sameMoney(actual, expected)) {
    throw new ConformanceFailure(
      `${what}: expected ${expected.toString()}, got ${actual.toString()}`,
    );
  }
};

const expectErrorCode = (
  result: Result<unknown>,
  code: string,
  what: string,
): void => {
  if (result.ok) {
    throw new ConformanceFailure(`${what}: expected ${code}, got a result`);
  }
  expectEqual(result.error.code, code, what);
};

const currencyOf = (pack: CountryPack): string => {
  const [currency] = pack.currencies.functional;
  if (!currency) {
    throw new ConformanceFailure('the pack has no functional currency');
  }
  return currency;
};

const requestFor = (
  subject: PackConformanceSubject,
  code: TaxCodeDef,
  direction: TaxRequest['direction'],
  net: string = SAMPLE_NET,
): TaxRequest => ({
  date: subject.asOf,
  direction,
  lines: [
    {
      id: 'line-1',
      net: Money.of(net, currencyOf(subject.pack)),
      taxCode: code.code,
    },
  ],
});

const calculated = (
  subject: PackConformanceSubject,
  request: TaxRequest,
  what: string,
): TaxCalculation => {
  const result = subject.pack.tax.calculate(request);
  if (!result.ok) {
    throw new ConformanceFailure(
      `${what}: calculate failed with ${result.error.code}`,
    );
  }
  return result.value;
};

const DIRECTIONS: readonly TaxRequest['direction'][] = ['sale', 'purchase'];

const structureCases: Case[] = PACK_AREAS.map((area) => ({
  name: `is well formed: ${area}`,
  run: async ({ pack }) => {
    expectEqual(
      findPackIssues(pack)
        .filter((issue) => issue.area === area)
        .map((issue) => issue.message),
      [],
      `${area} issues`,
    );
  },
}));

const registryCases: Case[] = [
  {
    name: 'can be registered and found by its country',
    run: async ({ pack }) => {
      const registry = createPackRegistry([pack]);
      expectEqual(registry.codes(), [pack.code], 'registered countries');
      expectTrue(registry.get(pack.code) === pack, 'get returns the pack');
    },
  },
  {
    name: 'carries every product it offers',
    run: async ({ pack, manifests }) => {
      expectEqual(
        findPackManifestIssues(pack, manifests ?? []).map(
          (issue) => issue.message,
        ),
        [],
        'product issues',
      );
    },
  },
];

const taxIdCases: Case[] = [
  {
    name: 'tax id: accepts valid numbers and returns them in canonical form',
    run: async ({ pack, samples }) => {
      expectTrue(
        samples.validTaxIds.length > 0,
        'the subject needs at least one valid tax id sample',
      );
      for (const [index, sample] of samples.validTaxIds.entries()) {
        const what = `valid sample ${index + 1}`;
        const result = pack.business.taxIdValidator(sample);
        if (!result.ok) {
          throw new ConformanceFailure(`${what} was rejected`);
        }
        expectTrue(
          !/\s/.test(result.value),
          `${what}: canonical has no spaces`,
        );
        // Surrounding spaces are a typing accident, not a different number.
        const padded = pack.business.taxIdValidator(`  ${sample} `);
        expectTrue(
          padded.ok && padded.value === result.value,
          `${what}: surrounding spaces are ignored`,
        );
        const again = pack.business.taxIdValidator(result.value);
        expectTrue(
          again.ok && again.value === result.value,
          `${what}: the canonical form validates to itself`,
        );
      }
    },
  },
  {
    name: 'tax id: rejects invalid numbers without quoting them',
    run: async ({ pack, samples }) => {
      expectTrue(
        samples.invalidTaxIds.length > 0,
        'the subject needs at least one invalid tax id sample',
      );
      for (const sample of ['', '   ', ...samples.invalidTaxIds]) {
        const result = pack.business.taxIdValidator(sample);
        if (result.ok) {
          throw new ConformanceFailure('an invalid tax id was accepted');
        }
        // An ID number must never reach a log or an error response.
        const trimmed = sample.trim();
        if (trimmed.length >= 3) {
          const text = `${result.error.message} ${JSON.stringify(result.error.details)}`;
          expectTrue(
            !text.includes(trimmed),
            'the error must not quote the tax id',
          );
        }
      }
    },
  },
  {
    name: 'registration fields: validators answer without throwing',
    run: async ({ pack }) => {
      for (const field of pack.business.registrationFields) {
        if (!field.validate) continue;
        const result = field.validate('');
        expectTrue(
          typeof result.ok === 'boolean',
          `field ${field.key} returns a Result`,
        );
      }
    },
  },
];

const taxCases: Case[] = [
  {
    name: 'tax: every rate is in force on the reference date',
    run: async ({ pack, asOf }) => {
      for (const code of pack.tax.codes) {
        for (const component of code.components) {
          expectTrue(
            component.rate.valueAt(asOf).ok,
            `${code.code} / ${component.key} has a rate on ${asOf}`,
          );
        }
      }
    },
  },
  {
    name: 'tax: every code calculates, and the amounts add up',
    run: async (subject) => {
      const { pack, asOf } = subject;
      for (const code of pack.tax.codes) {
        for (const direction of DIRECTIONS) {
          const what = `${code.code} ${direction}`;
          const request = requestFor(subject, code, direction);
          const result = calculated(subject, request, what);
          expectEqual(result.lines.length, 1, `${what}: one line back`);
          const [line] = result.lines;
          const [requested] = request.lines;
          if (!line || !requested) {
            throw new ConformanceFailure(`${what}: no line in the result`);
          }
          expectEqual(line.id, requested.id, `${what}: line id`);
          expectEqual(line.taxCode, code.code, `${what}: tax code`);
          expectMoney(line.net, requested.net, `${what}: net is unchanged`);

          expectEqual(
            line.components.map((component) => component.key),
            code.components.map((component) => component.key),
            `${what}: components, in the code's order`,
          );
          for (const component of line.components) {
            const definition = code.components.find(
              (candidate) => candidate.key === component.key,
            );
            const rate = definition?.rate.valueAt(asOf);
            expectTrue(
              rate?.ok === true && rate.value === component.rate,
              `${what}: ${component.key} reports the rate in force`,
            );
            expectTrue(
              component.amount.isInMinorUnits(),
              `${what}: ${component.key} is in minor units`,
            );
            expectEqual(
              component.role,
              direction === 'sale'
                ? definition?.outputRole
                : definition?.inputRole,
              `${what}: ${component.key} role`,
            );
          }
          expectMoney(
            line.tax,
            Money.sum(
              requested.net.currency,
              line.components.map((component) => component.amount),
            ),
            `${what}: line tax is the sum of its components`,
          );
          expectTrue(line.tax.isInMinorUnits(), `${what}: tax in minor units`);
          expectTrue(
            line.gross.isInMinorUnits(),
            `${what}: gross in minor units`,
          );
          if (code.treatment === 'standard' || code.treatment === 'reduced') {
            expectTrue(!line.tax.isNegative(), `${what}: tax is not negative`);
            expectMoney(
              line.gross,
              line.net.plus(line.tax),
              `${what}: gross is net plus tax`,
            );
          }
          expectMoney(result.totalNet, line.net, `${what}: total net`);
          expectMoney(result.totalTax, line.tax, `${what}: total tax`);
          expectMoney(result.totalGross, line.gross, `${what}: total gross`);
        }
      }
    },
  },
  {
    name: 'tax: zero-rated, exempt and out-of-scope codes charge nothing',
    run: async (subject) => {
      for (const code of subject.pack.tax.codes) {
        if (!UNTAXED_TREATMENTS.includes(code.treatment)) continue;
        for (const direction of DIRECTIONS) {
          const what = `${code.code} ${direction}`;
          const result = calculated(
            subject,
            requestFor(subject, code, direction),
            what,
          );
          // Lines and totals are checked separately: a line that charges
          // while the total says nothing is still a charge.
          for (const line of result.lines) {
            expectTrue(line.tax.isZero(), `${what}: no tax on the line`);
            expectMoney(line.gross, line.net, `${what}: line gross is net`);
          }
          expectTrue(result.totalTax.isZero(), `${what}: no tax`);
          expectMoney(
            result.totalGross,
            result.totalNet,
            `${what}: gross equals net`,
          );
        }
      }
    },
  },
  {
    name: 'tax: nothing is charged on a zero amount',
    run: async (subject) => {
      for (const code of subject.pack.tax.codes) {
        const what = `${code.code} on zero`;
        const result = calculated(
          subject,
          requestFor(subject, code, 'sale', '0'),
          what,
        );
        for (const line of result.lines) {
          expectTrue(line.tax.isZero(), `${what}: no tax on the line`);
          expectTrue(line.gross.isZero(), `${what}: no gross on the line`);
        }
        expectTrue(result.totalTax.isZero(), `${what}: no tax`);
        expectTrue(result.totalGross.isZero(), `${what}: no gross`);
      }
    },
  },
  {
    name: 'tax: totals are the sums of the lines',
    run: async (subject) => {
      const { pack, asOf } = subject;
      const currency = currencyOf(pack);
      const request: TaxRequest = {
        date: asOf,
        direction: 'sale',
        lines: pack.tax.codes.flatMap((code, index) => [
          {
            id: `a-${index}`,
            net: Money.of('333', currency),
            taxCode: code.code,
          },
          {
            id: `b-${index}`,
            net: Money.of('1667', currency),
            taxCode: code.code,
          },
        ]),
      };
      const result = calculated(subject, request, 'all codes together');
      expectEqual(
        result.lines.map((line) => line.id),
        request.lines.map((line) => line.id),
        'lines come back in the order they were sent',
      );
      const sum = (pick: (index: number) => Money): Money =>
        Money.sum(
          currency,
          result.lines.map((_, index) => pick(index)),
        );
      const at = (index: number) => {
        const line = result.lines[index];
        if (!line) throw new ConformanceFailure('a line is missing');
        return line;
      };
      expectMoney(
        result.totalNet,
        sum((i) => at(i).net),
        'total net',
      );
      expectMoney(
        result.totalTax,
        sum((i) => at(i).tax),
        'total tax',
      );
      expectMoney(
        result.totalGross,
        sum((i) => at(i).gross),
        'total gross',
      );
    },
  },
  {
    name: 'tax: the same request gives the same answer',
    run: async (subject) => {
      for (const code of subject.pack.tax.codes) {
        const request = requestFor(subject, code, 'sale');
        const before = JSON.stringify(request);
        const first = calculated(subject, request, code.code);
        const second = calculated(subject, request, code.code);
        expectEqual(second, first, `${code.code}: repeated calculation`);
        expectEqual(
          JSON.stringify(request),
          before,
          `${code.code}: the request is not changed`,
        );
      }
    },
  },
  {
    name: 'tax: the default codes exist and calculate',
    run: async (subject) => {
      const { tax } = subject.pack;
      for (const [direction, name] of [
        ['sale', tax.defaultSaleCode],
        ['purchase', tax.defaultPurchaseCode],
      ] as const) {
        const code = tax.codes.find((candidate) => candidate.code === name);
        if (!code) {
          throw new ConformanceFailure(`default ${direction} code is missing`);
        }
        calculated(
          subject,
          requestFor(subject, code, direction),
          `default ${direction} code`,
        );
      }
    },
  },
  {
    name: 'tax: a business with no registration answers is not liable',
    run: async ({ pack }) => {
      // Failing closed: charging tax by mistake is worse than not charging.
      expectEqual(pack.tax.isLiable({}), false, 'liable with no answers');
      expectEqual(
        pack.tax.isLiable({ no_such_field: 'anything' }),
        false,
        'liable with unknown answers',
      );
      // Whatever the answers, the question has an answer.
      for (const field of pack.business.registrationFields) {
        for (const option of field.options ?? []) {
          expectTrue(
            typeof pack.tax.isLiable({ [field.key]: option.key }) === 'boolean',
            `isLiable answers for ${field.key}=${option.key}`,
          );
        }
      }
    },
  },
  {
    name: 'tax: the code for a business that is not liable charges nothing',
    run: async (subject) => {
      const { tax } = subject.pack;
      const code = tax.codes.find(
        (candidate) => candidate.code === tax.notLiableCode,
      );
      if (!code) {
        throw new ConformanceFailure('the not-liable code is missing');
      }
      const result = calculated(
        subject,
        requestFor(subject, code, 'sale'),
        'not-liable code',
      );
      expectTrue(result.totalTax.isZero(), 'not-liable code: no tax');
      expectTrue(
        result.lines.every((line) => line.components.length === 0),
        'not-liable code: no tax components',
      );
    },
  },
  {
    name: 'tax: an unknown code is refused',
    run: async (subject) => {
      const result = subject.pack.tax.calculate({
        date: subject.asOf,
        direction: 'sale',
        lines: [
          {
            id: 'line-1',
            net: Money.of(SAMPLE_NET, currencyOf(subject.pack)),
            taxCode: 'NO_SUCH_CODE',
          },
        ],
      });
      expectErrorCode(result, TAX_ERRORS.CODE_UNKNOWN, 'unknown code');
    },
  },
  {
    name: 'tax: lines in different currencies are refused',
    run: async (subject) => {
      const { pack, asOf } = subject;
      const currency = currencyOf(pack);
      const other = currency === 'USD' ? 'EUR' : 'USD';
      const taxCode = pack.tax.defaultSaleCode;
      const result = pack.tax.calculate({
        date: asOf,
        direction: 'sale',
        lines: [
          { id: 'line-1', net: Money.of(SAMPLE_NET, currency), taxCode },
          { id: 'line-2', net: Money.of(SAMPLE_NET, other), taxCode },
        ],
      });
      expectErrorCode(result, TAX_ERRORS.CURRENCY_MIXED, 'mixed currencies');
    },
  },
  {
    name: 'tax: a date before any rate is refused, not guessed',
    run: async (subject) => {
      const taxed = subject.pack.tax.codes.filter(
        (code) => code.components.length > 0,
      );
      expectTrue(taxed.length > 0, 'the pack has a code with a rate');
      for (const code of taxed) {
        const result = subject.pack.tax.calculate({
          ...requestFor(subject, code, 'sale'),
          date: BEFORE_ALL_RATES,
        });
        expectErrorCode(
          result,
          RATE_ERRORS.NOT_IN_EFFECT,
          `${code.code} in ${BEFORE_ALL_RATES}`,
        );
      }
    },
  },
];

export const countryPackConformance: readonly Case[] = [
  ...structureCases,
  ...registryCases,
  ...taxIdCases,
  ...taxCases,
];
