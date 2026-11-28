import type { Channel } from '@hk/core/comms/domain';
import type { Identifier } from './identifier';

/**
 * One-time codes: the six digits sent to a phone or an email to prove the
 * person holds it.
 *
 * The rules, kept from BizTrack:
 *   - 6 digits, valid for 10 minutes;
 *   - 5 wrong attempts kill the code, and a new one must be requested;
 *   - a code works once;
 *   - asking for a new code kills the earlier ones for the same purpose;
 *   - at most 3 codes per 10 minutes for one identifier and purpose.
 *
 * One rule is ours: 60 seconds between two sends, so a double tap on
 * "resend" does not cost two messages.
 *
 * A code is never stored. What is stored is a keyed hash of it (see
 * OtpHasher in the application layer): with only a million possible codes,
 * a plain hash could be reversed by anyone who read the table.
 */
export const OTP_RULES = {
  length: 6,
  ttlSeconds: 10 * 60,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
  resendWindowSeconds: 10 * 60,
  resendMaxPerWindow: 3,
} as const;

export const OTP_PURPOSES = [
  /** Proving a phone number or email belongs to the account. */
  'verify_identifier',
  /** Signing in without a password. */
  'login',
  /** Setting a new password after forgetting the old one. */
  'password_reset',
] as const;

export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/** A code that was sent, as stored. */
export interface OtpChallenge {
  readonly id: string;
  readonly userId: string;
  readonly identifier: Identifier;
  readonly purpose: OtpPurpose;
  /** The channel the code went out on. */
  readonly channel: Channel;
  /** A keyed hash of the code, in hex. Never the code. */
  readonly codeHash: string;
  /** ISO 8601 instants. */
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Wrong attempts so far. */
  readonly attempts: number;
  /** When it was used, or when it was replaced or killed. Null while live. */
  readonly consumedAt: string | null;
}

/**
 * Compares two strings in time that does not depend on where they differ.
 * An ordinary comparison stops at the first different character, and the
 * time it takes would tell an attacker how much of a hash they had right.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
};

export type OtpVerdict =
  /** The code is right. Mark the challenge used. */
  | { outcome: 'accepted' }
  /** Wrong code. Record the attempt. */
  | { outcome: 'wrong'; attemptsLeft: number }
  /** Wrong code, and it was the last attempt allowed. Kill the challenge. */
  | { outcome: 'exhausted' }
  /** Past its time, used already, or replaced. No attempt is recorded. */
  | { outcome: 'expired' };

/**
 * Judges a submitted code against a stored challenge.
 *
 * `submittedHash` is the keyed hash of what the person typed. `now` is an
 * ISO 8601 instant. The function changes nothing; the caller stores the
 * consequence the verdict names.
 */
export const judgeOtp = (
  challenge: OtpChallenge | null,
  submittedHash: string,
  now: string,
): OtpVerdict => {
  if (
    !challenge ||
    challenge.consumedAt !== null ||
    challenge.expiresAt <= now ||
    challenge.attempts >= OTP_RULES.maxAttempts
  ) {
    return { outcome: 'expired' };
  }
  if (constantTimeEqual(challenge.codeHash, submittedHash)) {
    return { outcome: 'accepted' };
  }
  const attemptsLeft = OTP_RULES.maxAttempts - (challenge.attempts + 1);
  return attemptsLeft > 0
    ? { outcome: 'wrong', attemptsLeft }
    : { outcome: 'exhausted' };
};

export type ResendVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'too_soon' | 'limit'; retryAfterSeconds: number };

const secondsBetween = (earlier: string, later: string): number =>
  Math.floor((Date.parse(later) - Date.parse(earlier)) / 1000);

/**
 * Whether another code may be sent. `sentAt` holds when each code for this
 * identifier and purpose was sent (ISO 8601), in any order.
 */
export const judgeResend = (
  sentAt: readonly string[],
  now: string,
): ResendVerdict => {
  const ages = sentAt
    .map((sent) => secondsBetween(sent, now))
    .filter((age) => age >= 0 && age < OTP_RULES.resendWindowSeconds)
    .sort((a, b) => a - b);
  const newest = ages[0];
  if (newest !== undefined && newest < OTP_RULES.resendCooldownSeconds) {
    return {
      allowed: false,
      reason: 'too_soon',
      retryAfterSeconds: OTP_RULES.resendCooldownSeconds - newest,
    };
  }
  if (ages.length >= OTP_RULES.resendMaxPerWindow) {
    // The oldest code in the window is the next to fall out of it.
    const oldest = ages[ages.length - 1] ?? 0;
    return {
      allowed: false,
      reason: 'limit',
      retryAfterSeconds: OTP_RULES.resendWindowSeconds - oldest,
    };
  }
  return { allowed: true };
};

/** When a code sent at `now` stops working. */
export const otpExpiry = (now: Date): string =>
  new Date(now.getTime() + OTP_RULES.ttlSeconds * 1000).toISOString();

/** True for exactly six ASCII digits, which is all a code can be. */
export const isOtpCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{6}$/.test(value);
