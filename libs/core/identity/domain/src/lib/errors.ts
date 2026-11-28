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
} as const;

export type IdentityErrorCode =
  (typeof IDENTITY_ERRORS)[keyof typeof IDENTITY_ERRORS];
