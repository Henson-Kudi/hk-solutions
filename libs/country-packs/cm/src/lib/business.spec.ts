import type { Result } from '@hk/platform/universal';
import {
  CM_BUSINESS,
  CM_BUSINESS_ERRORS,
  CM_LEGAL_FORMS,
  CM_REGISTRATION_FIELDS,
  validateNiu,
  validateRccm,
} from './business';

// Every number in this file is invented. None is a real taxpayer or company.

const valueOf = (result: Result<string>) => (result.ok ? result.value : null);
const codeOf = (result: Result<string>) =>
  result.ok ? null : result.error.code;

describe('NIU', () => {
  it.each([
    ['M012345678901A', 'M012345678901A'],
    ['P098765432109Z', 'P098765432109Z'],
    ['m012345678901a', 'M012345678901A'],
    ['  M012345678901A ', 'M012345678901A'],
    ['M 0123 4567 8901 A', 'M012345678901A'],
  ])('accepts "%s" as %s', (input, canonical) => {
    expect(valueOf(validateNiu(input))).toBe(canonical);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'only spaces'],
    ['M01234567890A', 'eleven digits'],
    ['M0123456789012A', 'thirteen digits'],
    ['0123456789012A', 'no leading letter'],
    ['M0123456789012', 'no trailing letter'],
    ['MM12345678901A', 'two leading letters'],
    ['M01234567890OA', 'a letter among the digits'],
    ['M012345678901-A', 'punctuation'],
    ['M012345678901É', 'an accented letter'],
  ])('rejects "%s" (%s)', (input) => {
    expect(codeOf(validateNiu(input))).toBe(CM_BUSINESS_ERRORS.NIU_INVALID);
  });

  it('rejects a value that is not a string', () => {
    expect(codeOf(validateNiu(undefined as unknown as string))).toBe(
      CM_BUSINESS_ERRORS.NIU_INVALID,
    );
    expect(codeOf(validateNiu(12345678901234 as unknown as string))).toBe(
      CM_BUSINESS_ERRORS.NIU_INVALID,
    );
  });

  it('never quotes the number in its error', () => {
    const result = validateNiu('M01234567890XA');
    expect(result.ok).toBe(false);
    const text = result.ok ? '' : JSON.stringify(result.error.toJSON());
    expect(text).not.toContain('M01234567890XA');
    expect(text).not.toContain('01234567890');
  });

  it('is the tax id validator of the pack', () => {
    expect(CM_BUSINESS.taxIdValidator).toBe(validateNiu);
  });
});

describe('RCCM', () => {
  it.each([
    ['RC/DLA/2019/B/1234', 'RC/DLA/2019/B/1234'],
    ['RC/YAO/2008/A/12', 'RC/YAO/2008/A/12'],
    ['RC/DLA/2019/PM/127651', 'RC/DLA/2019/PM/127651'],
    ['rc/dla/2019/b/1234', 'RC/DLA/2019/B/1234'],
    [' RC / DLA / 2019 / B / 1234 ', 'RC/DLA/2019/B/1234'],
    ['CM-DLA-01-2019-B12-00001', 'CM-DLA-01-2019-B12-00001'],
    ['cm-yao-00-2023-a10-04321', 'CM-YAO-00-2023-A10-04321'],
  ])('accepts "%s" as %s', (input, canonical) => {
    expect(valueOf(validateRccm(input))).toBe(canonical);
  });

  it.each([
    ['', 'empty'],
    ['RC/DLA/2019/B', 'no number'],
    ['RC/DLA/19/B/1234', 'a two-digit year'],
    ['RC/DOUALA/2019/B/1234', 'a city that is not three letters'],
    ['RC/DLA/2019/B/1234567', 'a seven-digit number'],
    ['DLA/2019/B/1234', 'no register prefix'],
    ['CM-DLA-01-2019-B12-0001', 'OHADA form with four digits'],
    ['SN-DKR-01-2019-B12-00001', "another country's register"],
    ['RC/DLA/2019/B/1234; DROP', 'trailing text'],
  ])('rejects "%s" (%s)', (input) => {
    expect(codeOf(validateRccm(input))).toBe(CM_BUSINESS_ERRORS.RCCM_INVALID);
  });

  it('never quotes the number in its error', () => {
    const result = validateRccm('RC/DLA/2019/B/99999999');
    const text = result.ok ? '' : JSON.stringify(result.error.toJSON());
    expect(text).not.toContain('99999999');
  });
});

describe('registration fields', () => {
  const field = (key: string) => {
    const found = CM_REGISTRATION_FIELDS.find((item) => item.key === key);
    if (!found) throw new Error(`no field ${key}`);
    return found;
  };

  it('asks for NIU, RCCM and the tax regime', () => {
    expect(
      CM_REGISTRATION_FIELDS.map((item) => [item.key, item.required]),
    ).toEqual([
      ['niu', true],
      ['rccm', false],
      ['tax_regime', true],
    ]);
  });

  it('marks the ID numbers as sensitive, and validates them', () => {
    expect(field('niu').sensitive).toBe(true);
    expect(field('rccm').sensitive).toBe(true);
    expect(field('niu').validate).toBe(validateNiu);
    expect(field('rccm').validate).toBe(validateRccm);
  });

  it('offers the tax regimes as a choice', () => {
    expect(field('tax_regime').options?.map((option) => option.key)).toEqual([
      'real',
      'simplified',
      'flat',
    ]);
  });

  it('labels everything in French and English', () => {
    const texts = [
      ...CM_REGISTRATION_FIELDS.map((item) => item.label),
      ...CM_REGISTRATION_FIELDS.flatMap((item) =>
        (item.options ?? []).map((option) => option.label),
      ),
      ...CM_LEGAL_FORMS.map((form) => form.name),
    ];
    for (const text of texts) {
      expect(text.en.trim().length).toBeGreaterThan(0);
      expect(text.fr.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('legal forms', () => {
  it('lists the OHADA forms a business can take', () => {
    expect(CM_LEGAL_FORMS.map((form) => form.key)).toEqual([
      'ei',
      'sarl',
      'sa',
      'sas',
      'snc',
      'scs',
      'gie',
      'cooperative',
      'association',
    ]);
  });
});
