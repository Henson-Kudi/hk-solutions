/**
 * Error codes of the identity domain. Each is a stable identifier clients
 * branch on and translate.
 */
export const IDENTITY_ERRORS = {
  /** The phone number or email is not well formed. */
  IDENTIFIER_INVALID: 'IDENTITY_IDENTIFIER_INVALID',
  /** Sign-up with a phone number or email a verified account already has. */
  IDENTIFIER_TAKEN: 'IDENTITY_IDENTIFIER_TAKEN',
  /** Sign-up needs a phone number or an email. */
  IDENTIFIER_REQUIRED: 'IDENTITY_IDENTIFIER_REQUIRED',
  NAME_INVALID: 'IDENTITY_NAME_INVALID',
  /** The password does not meet the rules. Details say which. */
  PASSWORD_WEAK: 'IDENTITY_PASSWORD_WEAK',
  /**
   * Wrong password, unknown account, or an account that may not sign in.
   * Deliberately one code for all three, so a caller cannot find out which
   * phone numbers and emails have accounts.
   */
  CREDENTIALS_INVALID: 'IDENTITY_CREDENTIALS_INVALID',
  /** The code is wrong. Details carry how many attempts are left. */
  OTP_INVALID: 'IDENTITY_OTP_INVALID',
  /** The code is past its time, was already used, or was replaced by a newer one. */
  OTP_EXPIRED: 'IDENTITY_OTP_EXPIRED',
  /** Too many wrong attempts. The code is dead; a new one must be requested. */
  OTP_MAX_ATTEMPTS: 'IDENTITY_OTP_MAX_ATTEMPTS',
  /** A new code was asked for too soon after the last one. */
  OTP_RESEND_TOO_SOON: 'IDENTITY_OTP_RESEND_TOO_SOON',
  /** Too many codes were asked for in a short time. */
  OTP_RESEND_LIMIT: 'IDENTITY_OTP_RESEND_LIMIT',
  /** The code could not be sent on any channel. */
  OTP_DELIVERY_FAILED: 'IDENTITY_OTP_DELIVERY_FAILED',
  USER_NOT_FOUND: 'IDENTITY_USER_NOT_FOUND',
  /** The account is suspended or deleted. */
  ACCOUNT_UNAVAILABLE: 'IDENTITY_ACCOUNT_UNAVAILABLE',
  /**
   * Too many wrong passwords. Password sign-in is locked for a while; details
   * carry retryAfterSeconds. Signing in with a code still works.
   */
  ACCOUNT_LOCKED: 'IDENTITY_ACCOUNT_LOCKED',
  /**
   * The access or refresh token is unknown, expired, replaced or revoked.
   * One code for all, so nothing is learned from the answer. The HTTP layer
   * answers 401.
   */
  SESSION_INVALID: 'IDENTITY_SESSION_INVALID',
  /**
   * A passkey response was not accepted: the challenge is unknown or
   * expired, the passkey is not registered, or the signature does not
   * check. One code for all, so nothing is learned from the answer.
   */
  PASSKEY_INVALID: 'IDENTITY_PASSKEY_INVALID',
  /** The person already has as many passkeys as are allowed. */
  PASSKEY_LIMIT: 'IDENTITY_PASSKEY_LIMIT',
  /** The passkey is already registered, to this account or another. */
  PASSKEY_ALREADY_REGISTERED: 'IDENTITY_PASSKEY_ALREADY_REGISTERED',
  /** The person has no passkey with that id. */
  PASSKEY_NOT_FOUND: 'IDENTITY_PASSKEY_NOT_FOUND',
  /**
   * The person may not enter this business, or may not do this in it. One
   * code for "not a member", "suspended" and "lacks the permission", so a
   * stranger learns nothing about a business from the answer.
   */
  ACCESS_DENIED: 'IDENTITY_ACCESS_DENIED',
  /** A member of the business, but not allowed in this branch. */
  BRANCH_DENIED: 'IDENTITY_BRANCH_DENIED',
  /** A membership's branches must be "all" or a list of at least one branch. */
  BRANCH_SCOPE_INVALID: 'IDENTITY_BRANCH_SCOPE_INVALID',
  ROLE_NOT_FOUND: 'IDENTITY_ROLE_NOT_FOUND',
  ROLE_NAME_INVALID: 'IDENTITY_ROLE_NAME_INVALID',
  /** The business already has a role with this name. */
  ROLE_NAME_TAKEN: 'IDENTITY_ROLE_NAME_TAKEN',
  /** A permission in the list is not in the registry. */
  ROLE_PERMISSION_UNKNOWN: 'IDENTITY_ROLE_PERMISSION_UNKNOWN',
  /** The owner role cannot be changed, and no built-in role can be deleted. */
  ROLE_LOCKED: 'IDENTITY_ROLE_LOCKED',
  /** A role that members still hold cannot be deleted. */
  ROLE_IN_USE: 'IDENTITY_ROLE_IN_USE',
  /** The business has as many roles as are allowed. */
  ROLE_LIMIT: 'IDENTITY_ROLE_LIMIT',
  /** Nobody can grant a permission they do not hold themselves. */
  PERMISSION_EXCEEDS_OWN: 'IDENTITY_PERMISSION_EXCEEDS_OWN',
  MEMBER_NOT_FOUND: 'IDENTITY_MEMBER_NOT_FOUND',
  /** The person is already a member of the business. */
  MEMBER_EXISTS: 'IDENTITY_MEMBER_EXISTS',
  /** The owner's membership cannot be changed, suspended or removed. */
  OWNER_PROTECTED: 'IDENTITY_OWNER_PROTECTED',
  /** Nobody changes their own membership. */
  SELF_CHANGE_FORBIDDEN: 'IDENTITY_SELF_CHANGE_FORBIDDEN',
  /** Someone else changed the role or membership first. Read it again and retry. */
  CHANGED_MEANWHILE: 'IDENTITY_CHANGED_MEANWHILE',
} as const;

export type IdentityErrorCode =
  (typeof IDENTITY_ERRORS)[keyof typeof IDENTITY_ERRORS];
