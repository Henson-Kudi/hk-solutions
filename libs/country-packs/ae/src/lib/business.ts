import type {
  FieldDef,
  FieldOption,
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
 * Business identity in the UAE: legal forms, the tax registration number
 * (TRN), the emirate, and where the business is established.
 *
 * UNCONFIRMED. The TRN format (15 digits) comes from secondary sources; the
 * Federal Tax Authority publishes no specification, and no check digit rule.
 * The validator checks shape only. It cannot tell whether a number has been
 * issued: the FTA's own lookup does that.
 *
 * Errors never quote the number. A TRN is an ID number and must not reach
 * logs or error responses.
 */

export const AE_BUSINESS_ERRORS = {
  TRN_INVALID: 'AE_TRN_INVALID',
} as const;

/** Spaces and dashes are how a TRN is printed (100-1234-5678-9123), not part of it. */
const compact = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[\s-]+/g, '') : '';

const TRN = /^\d{15}$/;

/**
 * TRN, tax registration number: issued by the Federal Tax Authority. Used
 * for VAT, and in the same format for Corporate Tax. Returns the 15 digits.
 */
export const validateTrn = (value: string): Result<string> => {
  const canonical = compact(value);
  return TRN.test(canonical)
    ? ok(canonical)
    : err(
        new DomainError(AE_BUSINESS_ERRORS.TRN_INVALID, 'A TRN is 15 digits.'),
      );
};

/** The seven emirates. */
export const AE_EMIRATES: readonly FieldOption[] = [
  { key: 'abu_dhabi', label: localizedText('Abu Dhabi', 'Abou Dabi') },
  { key: 'dubai', label: localizedText('Dubai', 'Dubaï') },
  { key: 'sharjah', label: localizedText('Sharjah', 'Charjah') },
  { key: 'ajman', label: localizedText('Ajman', 'Ajman') },
  {
    key: 'umm_al_quwain',
    label: localizedText('Umm Al Quwain', 'Oumm al Qaïwaïn'),
  },
  {
    key: 'ras_al_khaimah',
    label: localizedText('Ras Al Khaimah', 'Ras el Khaïmah'),
  },
  { key: 'fujairah', label: localizedText('Fujairah', 'Fujaïrah') },
];

/**
 * Where the business is established. The list of free zones, and of the
 * "designated zones" that VAT treats as outside the UAE, is set by Cabinet
 * decisions and changes, so the pack asks for the kind of place and takes the
 * zone's name as text. It does not hold the list.
 */
export const AE_ESTABLISHMENTS: readonly FieldOption[] = [
  { key: 'mainland', label: localizedText('Mainland', 'Territoire principal') },
  {
    key: 'free_zone',
    label: localizedText('Free zone', 'Zone franche'),
  },
  {
    key: 'designated_zone',
    label: localizedText(
      'Designated zone (for VAT)',
      'Zone désignée (au sens de la TVA)',
    ),
  },
];

export const AE_LEGAL_FORMS: readonly LegalForm[] = [
  {
    key: 'sole_establishment',
    name: localizedText('Sole establishment', 'Entreprise individuelle'),
  },
  {
    key: 'civil_company',
    name: localizedText('Civil company', 'Société civile'),
  },
  {
    key: 'llc',
    name: localizedText(
      'Limited liability company (LLC)',
      'Société à responsabilité limitée (LLC)',
    ),
  },
  {
    key: 'pjsc',
    name: localizedText(
      'Public joint stock company (PJSC)',
      'Société anonyme publique (PJSC)',
    ),
  },
  {
    key: 'prjsc',
    name: localizedText(
      'Private joint stock company (PrJSC)',
      'Société anonyme privée (PrJSC)',
    ),
  },
  {
    key: 'partnership',
    name: localizedText('Partnership', 'Société de personnes'),
  },
  {
    key: 'branch',
    name: localizedText(
      'Branch of a foreign or UAE company',
      "Succursale d'une société étrangère ou émirienne",
    ),
  },
  {
    key: 'free_zone_establishment',
    name: localizedText(
      'Free zone establishment (FZE)',
      'Établissement de zone franche (FZE)',
    ),
  },
  {
    key: 'free_zone_company',
    name: localizedText(
      'Free zone company (FZCO, FZ-LLC)',
      'Société de zone franche (FZCO, FZ-LLC)',
    ),
  },
];

export const AE_REGISTRATION_FIELDS: readonly FieldDef[] = [
  {
    key: 'vat_status',
    label: localizedText('VAT registration', 'Immatriculation à la TVA'),
    required: true,
    kind: 'select',
    // Only a registered business charges and recovers VAT: see
    // isLiableForAeVat in tax/engine.ts.
    options: [
      {
        key: 'registered',
        label: localizedText('Registered for VAT', 'Immatriculée à la TVA'),
      },
      {
        key: 'not_registered',
        label: localizedText(
          'Not registered for VAT',
          'Non immatriculée à la TVA',
        ),
      },
    ],
  },
  {
    key: 'trn',
    label: localizedText(
      'Tax registration number (TRN)',
      "Numéro d'immatriculation fiscale (TRN)",
    ),
    // A business below the registration threshold has none.
    required: false,
    kind: 'text',
    sensitive: true,
    validate: validateTrn,
  },
  {
    key: 'corporate_tax_trn',
    label: localizedText(
      'Corporate Tax registration number',
      "Numéro d'immatriculation à l'impôt sur les sociétés",
    ),
    required: false,
    kind: 'text',
    sensitive: true,
    validate: validateTrn,
  },
  {
    key: 'emirate',
    label: localizedText('Emirate', 'Émirat'),
    required: true,
    kind: 'select',
    options: AE_EMIRATES,
  },
  {
    key: 'establishment',
    label: localizedText('Established in', "Lieu d'établissement"),
    required: true,
    kind: 'select',
    options: AE_ESTABLISHMENTS,
  },
  {
    key: 'free_zone_name',
    label: localizedText('Name of the free zone', 'Nom de la zone franche'),
    required: false,
    kind: 'text',
  },
];

export const AE_BUSINESS: PackBusiness = {
  legalForms: AE_LEGAL_FORMS,
  registrationFields: AE_REGISTRATION_FIELDS,
  taxIdValidator: validateTrn,
};
