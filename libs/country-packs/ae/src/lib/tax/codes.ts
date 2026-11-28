import { createRateTable, type TaxCodeDef } from '@hk/country-packs/kernel';
import { localizedText } from '@hk/platform/universal';
import { SOURCES } from '../sources';

/**
 * UAE VAT codes.
 *
 * One rate, 5%, since VAT began on 1 January 2018. The codes differ in how a
 * supply is treated, not in the rate:
 *
 *   VAT_STD            taxable at 5%
 *   VAT_ZERO           taxable at 0% (exports, and some supplies by law)
 *   VAT_EXEMPT         exempt: no tax, and no recovery of tax on its costs
 *   VAT_OUT_OF_SCOPE   outside VAT altogether
 *   VAT_RC             reverse charge: the buyer accounts for the 5% itself
 *
 * All rates are unconfirmed (see ../sources.ts).
 */

/** The day VAT began in the UAE. Documents dated earlier get no rate. */
const VAT_FROM = '2018-01-01';

const vat = localizedText('VAT', 'TVA');

export const AE_TAX_CODES: readonly TaxCodeDef[] = [
  {
    code: 'VAT_STD',
    name: localizedText('VAT 5% (standard rate)', 'TVA 5 % (taux normal)'),
    treatment: 'standard',
    components: [
      {
        key: 'vat',
        name: vat,
        rate: createRateTable('ae.vat.standard', [
          {
            effectiveFrom: VAT_FROM,
            value: '0.05',
            source: SOURCES.vatStandardRate,
          },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
    ],
  },
  {
    code: 'VAT_ZERO',
    name: localizedText('VAT 0% (zero-rated)', 'TVA 0 % (taux zéro)'),
    treatment: 'zero_rated',
    components: [
      {
        key: 'vat',
        name: vat,
        rate: createRateTable('ae.vat.zero', [
          { effectiveFrom: VAT_FROM, value: '0', source: SOURCES.vatZeroRate },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
    ],
  },
  {
    code: 'VAT_EXEMPT',
    name: localizedText('VAT exempt', 'Exonéré de TVA'),
    treatment: 'exempt',
    components: [],
  },
  {
    code: 'VAT_OUT_OF_SCOPE',
    name: localizedText('Outside the scope of VAT', 'Hors champ de la TVA'),
    treatment: 'out_of_scope',
    components: [],
  },
  {
    code: 'VAT_RC',
    name: localizedText(
      'VAT reverse charge (buyer accounts for 5%)',
      "TVA autoliquidée (5 % à la charge de l'acheteur)",
    ),
    treatment: 'reverse_charge',
    components: [
      {
        key: 'vat',
        name: vat,
        // The rate a supplier in the UAE would have charged.
        rate: createRateTable('ae.vat.reverse_charge', [
          {
            effectiveFrom: VAT_FROM,
            value: '0.05',
            source: SOURCES.vatReverseCharge,
          },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
    ],
  },
];
