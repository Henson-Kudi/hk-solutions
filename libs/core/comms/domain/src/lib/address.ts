import { DomainError, err, ok, type Result } from '@hk/platform/universal';
import { COMMS_ERRORS } from './errors';

/**
 * Addresses: where a message goes.
 *
 * An email address and a phone number are personal data. They are validated
 * and normalised here, and never quoted in an error. Use maskEmail and
 * maskPhone whenever one has to appear in a log or on a screen.
 */

const invalid = (what: string): DomainError =>
  new DomainError(COMMS_ERRORS.ADDRESS_INVALID, `That is not a valid ${what}.`);

const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
/** Letters, digits and the punctuation mail systems accept without quoting. */
const EMAIL_LOCAL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const EMAIL_DOMAIN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Checks an email address and returns it trimmed, with the domain in lower
 * case. The part before the @ keeps its case: some mail systems care.
 *
 * It checks shape, not existence. Only sending a message proves an address
 * works.
 */
export const parseEmailAddress = (input: unknown): Result<string> => {
  if (typeof input !== 'string') return err(invalid('email address'));
  const value = input.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || value.length > EMAIL_MAX) return err(invalid('email address'));
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local.length > LOCAL_MAX ||
    !EMAIL_LOCAL.test(local) ||
    !EMAIL_DOMAIN.test(domain)
  ) {
    return err(invalid('email address'));
  }
  return ok(`${local}@${domain.toLowerCase()}`);
};

/** A plus sign and 8 to 15 digits, the first not zero: the E.164 form. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Checks a phone number and returns it in E.164 form: "+237677123456".
 *
 * Spaces, dashes, dots and brackets are how people write numbers and are
 * dropped. The number must start with "+" and its country code: there is no
 * default country, because guessing one would send a message to the wrong
 * person in another country.
 */
export const parsePhoneNumber = (input: unknown): Result<string> => {
  if (typeof input !== 'string') return err(invalid('phone number'));
  const compact = input.replace(/[\s().-]+/g, '');
  return E164.test(compact) ? ok(compact) : err(invalid('phone number'));
};

const DOT = '•';

/**
 * An email address safe to show or log: "h•••@example.com". The domain stays,
 * because it helps a user recognise the address and identifies nobody.
 */
export const maskEmail = (address: string): string => {
  const at = address.lastIndexOf('@');
  if (at <= 0) return DOT.repeat(3);
  return `${address.slice(0, 1)}${DOT.repeat(3)}${address.slice(at)}`;
};

/**
 * A phone number safe to show or log: "+237•••••456". The country code and
 * the last three digits stay; the rest is hidden.
 */
export const maskPhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return DOT.repeat(5);
  return `+${digits.slice(0, 3)}${DOT.repeat(5)}${digits.slice(-3)}`;
};
