import { createRateTable, type TaxCodeDef } from '@hk/country-packs/kernel';
import { localizedText } from '@hk/platform/universal';
import { SOURCES } from '../sources';

/**
 * Cameroon VAT codes.
 *
 * The standard rate has two components. The VAT itself (TVA) is 17.5% of the
 * net amount. The communal surcharge (centimes additionnels communaux, CAC)
 * is 10% of the VAT, which is 1.75% of the net amount. Together: 19.25%.
 *
 * The surcharge is stored as its share of the net amount ("0.0175"), because
 * every rate in a pack is a fraction of the net. If the VAT rate changes, the
 * surcharge entry must change with it; a test checks the two agree.
 *
 * All rates are unconfirmed (see ../sources.ts).
 */

/** The surcharge as a fraction of the VAT. Kept only to check the two rate tables agree. */
export const CAC_SHARE_OF_VAT = '0.10';

/**
 * First day the rates below are taken to apply. To confirm. Documents dated
 * earlier get no rate at all, which is the intent: the pack does not know the
 * rates of earlier years.
 */
const RATES_FROM = '2005-01-01';

export const CM_TAX_CODES: readonly TaxCodeDef[] = [
  {
    code: 'TVA_STD',
    name: localizedText('VAT 19.25% (standard)', 'TVA 19,25 % (taux général)'),
    treatment: 'standard',
    components: [
      {
        key: 'tva',
        name: localizedText('VAT', 'TVA'),
        rate: createRateTable('cm.vat.standard.tva', [
          {
            effectiveFrom: RATES_FROM,
            value: '0.175',
            source: SOURCES.vatStandardRate,
          },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
      {
        key: 'cac',
        name: localizedText(
          'Communal surcharge (CAC)',
          'Centimes additionnels communaux (CAC)',
        ),
        rate: createRateTable('cm.vat.standard.cac', [
          {
            effectiveFrom: RATES_FROM,
            value: '0.0175',
            source: SOURCES.vatCommunalSurcharge,
          },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
    ],
  },
  {
    code: 'TVA_EXPORT',
    name: localizedText('VAT 0% (exports)', 'TVA 0 % (exportations)'),
    treatment: 'zero_rated',
    components: [
      {
        key: 'tva',
        name: localizedText('VAT', 'TVA'),
        rate: createRateTable('cm.vat.zero.tva', [
          {
            effectiveFrom: RATES_FROM,
            value: '0',
            source: SOURCES.vatZeroRate,
          },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
    ],
  },
  {
    code: 'TVA_EXEMPT',
    name: localizedText('VAT exempt', 'Exonéré de TVA'),
    treatment: 'exempt',
    components: [],
  },
  {
    code: 'TVA_OUT_OF_SCOPE',
    name: localizedText('Outside the scope of VAT', 'Hors champ de la TVA'),
    treatment: 'out_of_scope',
    components: [],
  },
];
