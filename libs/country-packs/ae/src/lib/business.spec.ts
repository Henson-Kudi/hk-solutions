import type { Result } from '@hk/platform/universal';
import {
  AE_BUSINESS,
  AE_BUSINESS_ERRORS,
  AE_EMIRATES,
  AE_ESTABLISHMENTS,
  AE_LEGAL_FORMS,
  AE_REGISTRATION_FIELDS,
  validateTrn,
} from './business';

// Every number in this file is invented. None is a real registration.

const valueOf = (result: Result<string>) => (result.ok ? result.value : null);
const codeOf = (result: Result<string>) =>
  result.ok ? null : result.error.code;

describe('TRN', () => {
  it.each([
    ['100000000000003', '100000000000003'],
    ['104999999999993', '104999999999993'],
    ['  100000000000003 ', '100000000000003'],
    ['100-0000-0000-0003', '100000000000003'],
    ['100 0000 0000 0003', '100000000000003'],
  ])('accepts "%s" as %s', (input, canonical) => {
    expect(valueOf(validateTrn(input))).toBe(canonical);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'only spaces'],
    ['10000000000000', 'fourteen digits'],
    ['1000000000000030', 'sixteen digits'],
    ['10000000000000A', 'a letter'],
    ['TRN100000000000003', 'a prefix'],
    ['100.0000.0000.0003', 'dots'],
    ['١٠٠٠٠٠٠٠٠٠٠٠٠٠٣', 'Arabic-Indic digits'],
  ])('rejects "%s" (%s)', (input) => {
    expect(codeOf(validateTrn(input))).toBe(AE_BUSINESS_ERRORS.TRN_INVALID);
  });

  it('rejects a value that is not a string', () => {
    expect(codeOf(validateTrn(undefined as unknown as string))).toBe(
      AE_BUSINESS_ERRORS.TRN_INVALID,
    );
    expect(codeOf(validateTrn(100000000000003 as unknown as string))).toBe(
      AE_BUSINESS_ERRORS.TRN_INVALID,
    );
  });

  it('never quotes the number in its error', () => {
    const result = validateTrn('10000000000000X');
    expect(result.ok).toBe(false);
    const text = result.ok ? '' : JSON.stringify(result.error.toJSON());
    expect(text).not.toContain('10000000000000');
  });

  it('is the tax id validator of the pack', () => {
    expect(AE_BUSINESS.taxIdValidator).toBe(validateTrn);
  });
});

describe('registration fields', () => {
  const field = (key: string) => {
    const found = AE_REGISTRATION_FIELDS.find((item) => item.key === key);
    if (!found) throw new Error(`no field ${key}`);
    return found;
  };

  it('asks for VAT status, TRNs, emirate and where the business is established', () => {
    expect(
      AE_REGISTRATION_FIELDS.map((item) => [item.key, item.required]),
    ).toEqual([
      ['vat_status', true],
      ['trn', false],
      ['corporate_tax_trn', false],
      ['emirate', true],
      ['establishment', true],
      ['free_zone_name', false],
    ]);
  });

  it('does not require a TRN, because a small business has none', () => {
    expect(field('trn').required).toBe(false);
  });

  it('marks the registration numbers as sensitive, and validates them', () => {
    for (const key of ['trn', 'corporate_tax_trn']) {
      expect(field(key).sensitive).toBe(true);
      expect(field(key).validate).toBe(validateTrn);
    }
  });

  it('offers the seven emirates', () => {
    expect(field('emirate').options).toBe(AE_EMIRATES);
    expect(AE_EMIRATES.map((emirate) => emirate.key)).toEqual([
      'abu_dhabi',
      'dubai',
      'sharjah',
      'ajman',
      'umm_al_quwain',
      'ras_al_khaimah',
      'fujairah',
    ]);
  });

  it('asks whether the business is on the mainland, in a free zone or in a designated zone', () => {
    expect(field('establishment').options).toBe(AE_ESTABLISHMENTS);
    expect(AE_ESTABLISHMENTS.map((place) => place.key)).toEqual([
      'mainland',
      'free_zone',
      'designated_zone',
    ]);
    // The zone is named in text: the list of zones is not held in the pack.
    expect(field('free_zone_name').kind).toBe('text');
  });

  it('labels everything in English and French', () => {
    const texts = [
      ...AE_REGISTRATION_FIELDS.map((item) => item.label),
      ...AE_REGISTRATION_FIELDS.flatMap((item) =>
        (item.options ?? []).map((option) => option.label),
      ),
      ...AE_LEGAL_FORMS.map((form) => form.name),
    ];
    for (const text of texts) {
      expect(text.en.trim().length).toBeGreaterThan(0);
      expect(text.fr.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('legal forms', () => {
  it('lists the forms a business in the UAE can take', () => {
    expect(AE_LEGAL_FORMS.map((form) => form.key)).toEqual([
      'sole_establishment',
      'civil_company',
      'llc',
      'pjsc',
      'prjsc',
      'partnership',
      'branch',
      'free_zone_establishment',
      'free_zone_company',
    ]);
  });
});
