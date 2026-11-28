import {
  DEFAULT_LOCALE,
  DomainError,
  err,
  isLocale,
  ok,
  type Locale,
  type Result,
} from '@hk/platform/universal';
import { IDENTITY_ERRORS } from './errors';
import type { Identifier, IdentifierKind } from './identifier';

/**
 * A user: one person, with the phone number and email they sign in with.
 *
 * A user is not tied to a business. One person can belong to several
 * businesses (as a member of each), and signs in once for all of them.
 *
 *   pending     signed up, nothing verified yet; cannot sign in
 *   active      at least one identifier verified
 *   suspended   blocked by the platform; cannot sign in
 *   deleted     closed; kept only as a trace
 */
export const USER_STATUSES = [
  'pending',
  'active',
  'suspended',
  'deleted',
] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserIdentifier extends Identifier {
  /** When the person proved they hold it. Null until then. */
  readonly verifiedAt: string | null;
}

export interface User {
  readonly id: string;
  readonly name: string;
  readonly locale: Locale;
  readonly status: UserStatus;
  /** At most one phone number and one email, the phone first. */
  readonly identifiers: readonly UserIdentifier[];
  /** Whether a password is set. The hash itself never leaves the repository. */
  readonly hasPassword: boolean;
  readonly createdAt: string;
}

const NAME_MIN = 2;
const NAME_MAX = 60;

/** A person's name: trimmed, 2 to 60 characters, no line breaks or control characters. */
export const parseUserName = (input: unknown): Result<string> => {
  const name =
    typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  const length = Array.from(name).length;
  const hasControl = Array.from(name).some((char) => char.charCodeAt(0) < 0x20);
  if (length < NAME_MIN || length > NAME_MAX || hasControl) {
    return err(
      new DomainError(
        IDENTITY_ERRORS.NAME_INVALID,
        `A name is ${NAME_MIN} to ${NAME_MAX} characters.`,
      ),
    );
  }
  return ok(name);
};

export const parseUserLocale = (input: unknown): Locale =>
  isLocale(input) ? input : DEFAULT_LOCALE;

export const identifierOf = (
  user: User,
  kind: IdentifierKind,
): UserIdentifier | undefined =>
  user.identifiers.find((identifier) => identifier.kind === kind);

/**
 * The identifier the person should verify next: the phone first, then the
 * email. Undefined when everything is verified.
 */
export const nextToVerify = (user: User): UserIdentifier | undefined =>
  identifierOf(user, 'phone')?.verifiedAt === null
    ? identifierOf(user, 'phone')
    : user.identifiers.find((identifier) => identifier.verifiedAt === null);

/** Whether the person has proved they hold at least one identifier. */
export const hasVerifiedIdentifier = (user: User): boolean =>
  user.identifiers.some((identifier) => identifier.verifiedAt !== null);

/** Whether the account may be signed in to. */
export const canSignIn = (user: User): boolean =>
  user.status === 'active' && hasVerifiedIdentifier(user);

/**
 * The status after an identifier is verified: a pending account becomes
 * active. A suspended or deleted account stays as it is; verifying a phone
 * number is not a way back in.
 */
export const statusAfterVerification = (status: UserStatus): UserStatus =>
  status === 'pending' ? 'active' : status;
