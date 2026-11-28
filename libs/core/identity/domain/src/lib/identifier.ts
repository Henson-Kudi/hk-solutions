import {
  maskEmail,
  maskPhone,
  parseEmailAddress,
  parsePhoneNumber,
  type Channel,
} from '@hk/core/comms/domain';
import { DomainError, err, ok, type Result } from '@hk/platform/universal';
import { IDENTITY_ERRORS } from './errors';

/**
 * Identifiers: what a person signs in with. A phone number or an email
 * address. There are no usernames.
 *
 * An identifier is personal data. Errors never quote one; use
 * maskIdentifier wherever one has to be shown.
 */

export const IDENTIFIER_KINDS = ['phone', 'email'] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export interface Identifier {
  readonly kind: IdentifierKind;
  /**
   * The value accounts are matched on: a phone number in E.164 form, or an
   * email address in lower case. Two spellings of one address are one
   * identifier.
   */
  readonly value: string;
}

const invalid = (): DomainError =>
  new DomainError(
    IDENTITY_ERRORS.IDENTIFIER_INVALID,
    'Enter a phone number with its country code, or an email address.',
  );

export const parsePhoneIdentifier = (input: unknown): Result<Identifier> => {
  const phone = parsePhoneNumber(input);
  return phone.ok ? ok({ kind: 'phone', value: phone.value }) : err(invalid());
};

export const parseEmailIdentifier = (input: unknown): Result<Identifier> => {
  const email = parseEmailAddress(input);
  // Lower case throughout: almost every mail system treats the part before
  // the @ as case-insensitive, and two accounts differing only in case would
  // be a trap for their owners.
  return email.ok
    ? ok({ kind: 'email', value: email.value.toLowerCase() })
    : err(invalid());
};

/**
 * Reads what a person typed into a "phone or email" box. Anything with an @
 * is an email address; anything else must be a phone number.
 */
export const parseIdentifier = (input: unknown): Result<Identifier> => {
  if (typeof input !== 'string') return err(invalid());
  return input.includes('@')
    ? parseEmailIdentifier(input)
    : parsePhoneIdentifier(input);
};

export const sameIdentifier = (a: Identifier, b: Identifier): boolean =>
  a.kind === b.kind && a.value === b.value;

/** An identifier safe to show or log: "+237•••••001", "o•••@example.com". */
export const maskIdentifier = (identifier: Identifier): string =>
  identifier.kind === 'phone'
    ? maskPhone(identifier.value)
    : maskEmail(identifier.value);

/** The channels a code can reach an identifier on, the usual one first. */
export const channelsFor = (kind: IdentifierKind): readonly Channel[] =>
  kind === 'phone' ? ['sms', 'whatsapp'] : ['email'];
