import type {
  FieldDef,
  LegalForm,
  PackBusiness,
} from '@hk/country-packs/kernel';
import {
  DomainError,
  err,
  localizedText,
  ok,
  type Result,
} from '@hk/platform/universal';

/**
 * Business identity in Cameroon: legal forms, the tax identifier (NIU), the
 * trade register number (RCCM) and the tax regime.
 *
 * UNCONFIRMED. The formats below come from secondary sources, not from a
 * published specification of the tax authority or of the trade register
 * (docs/country-packs/cm.md). The validators check shape only: they cannot
 * tell whether a number has been issued.
 *
 * Errors never quote the number. NIU and RCCM are ID numbers and must not
 * reach logs or error responses.
 */

export const CM_BUSINESS_ERRORS = {
  NIU_INVALID: 'CM_NIU_INVALID',
  RCCM_INVALID: 'CM_RCCM_INVALID',
} as const;

/** Spaces inside a number are how people type and read it aloud, not part of it. */
const compact = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';

/** One letter, twelve digits, one letter: 14 characters. */
const NIU = /^[A-Z]\d{12}[A-Z]$/;

/**
 * NIU, numéro d'identifiant unique: the taxpayer number issued by the tax
 * authority (DGI). Returns it upper-cased with no spaces.
 */
export const validateNiu = (value: string): Result<string> => {
  const canonical = compact(value);
  return NIU.test(canonical)
    ? ok(canonical)
    : err(
        new DomainError(
          CM_BUSINESS_ERRORS.NIU_INVALID,
          'A NIU is 14 characters: a letter, 12 digits and a letter.',
        ),
      );
};

/** The older national form: RC/DLA/2019/B/1234. */
const RCCM_NATIONAL = /^RC\/[A-Z]{3}\/\d{4}\/[A-Z]{1,3}\/\d{1,6}$/;
/** The OHADA nomenclature: CM-DLA-01-2019-B12-00001. */
const RCCM_OHADA = /^CM-[A-Z]{3}-\d{2}-\d{4}-[A-Z0-9]{3}-\d{5}$/;

/**
 * RCCM, registre du commerce et du crédit mobilier: the trade register
 * number. Both the older national form and the OHADA form are accepted,
 * because businesses registered at different times hold different ones.
 */
export const validateRccm = (value: string): Result<string> => {
  const canonical = compact(value);
  return RCCM_NATIONAL.test(canonical) || RCCM_OHADA.test(canonical)
    ? ok(canonical)
    : err(
        new DomainError(
          CM_BUSINESS_ERRORS.RCCM_INVALID,
          'An RCCM number looks like RC/DLA/2019/B/1234 or CM-DLA-01-2019-B12-00001.',
        ),
      );
};

/** Forms of business under the OHADA Uniform Act on commercial companies. */
export const CM_LEGAL_FORMS: readonly LegalForm[] = [
  {
    key: 'ei',
    name: localizedText('Sole proprietorship', 'Entreprise individuelle'),
  },
  {
    key: 'sarl',
    name: localizedText(
      'Private limited company (SARL)',
      'Société à responsabilité limitée (SARL)',
    ),
  },
  {
    key: 'sa',
    name: localizedText('Public limited company (SA)', 'Société anonyme (SA)'),
  },
  {
    key: 'sas',
    name: localizedText(
      'Simplified joint-stock company (SAS)',
      'Société par actions simplifiée (SAS)',
    ),
  },
  {
    key: 'snc',
    name: localizedText(
      'General partnership (SNC)',
      'Société en nom collectif (SNC)',
    ),
  },
  {
    key: 'scs',
    name: localizedText(
      'Limited partnership (SCS)',
      'Société en commandite simple (SCS)',
    ),
  },
  {
    key: 'gie',
    name: localizedText(
      'Economic interest group (GIE)',
      "Groupement d'intérêt économique (GIE)",
    ),
  },
  {
    key: 'cooperative',
    name: localizedText('Cooperative society', 'Société coopérative'),
  },
  {
    key: 'association',
    name: localizedText('Association', 'Association'),
  },
];

export const CM_REGISTRATION_FIELDS: readonly FieldDef[] = [
  {
    key: 'niu',
    label: localizedText(
      'Taxpayer number (NIU)',
      "Numéro d'identifiant unique (NIU)",
    ),
    required: true,
    kind: 'text',
    sensitive: true,
    validate: validateNiu,
  },
  {
    key: 'rccm',
    label: localizedText(
      'Trade register number (RCCM)',
      'Numéro du registre du commerce (RCCM)',
    ),
    // Not every business is in the trade register: associations are not.
    required: false,
    kind: 'text',
    sensitive: true,
    validate: validateRccm,
  },
  {
    key: 'tax_regime',
    label: localizedText('Tax regime', "Régime d'imposition"),
    required: true,
    kind: 'select',
    // Code Général des Impôts 2026, art. 93 ter. The regime follows from
    // turnover (art. 93 quater): the general synthetic tax below 50 million
    // F CFA a year (30 million for liberal professions), the actual earnings
    // regime from there up. Only the actual earnings regime charges VAT
    // (art. 132); see CM_VAT_LIABLE_REGIME in tax/engine.ts.
    options: [
      {
        key: 'igs',
        label: localizedText(
          'General synthetic tax (IGS)',
          'Impôt général synthétique (IGS)',
        ),
      },
      {
        key: 'real',
        label: localizedText('Actual earnings regime', 'Régime réel'),
      },
      {
        key: 'non_profit',
        label: localizedText(
          'Non-profit organisation',
          'Organisme à but non lucratif',
        ),
      },
      {
        key: 'non_professional',
        label: localizedText(
          'Non-professional taxpayer',
          'Contribuable non professionnel',
        ),
      },
    ],
  },
];

export const CM_BUSINESS: PackBusiness = {
  legalForms: CM_LEGAL_FORMS,
  registrationFields: CM_REGISTRATION_FIELDS,
  taxIdValidator: validateNiu,
};
