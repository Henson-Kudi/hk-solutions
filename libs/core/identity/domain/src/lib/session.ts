/**
 * Sessions: what a person holds after signing in.
 *
 * A session has a chain of token pairs. Each pair is a short-lived access
 * token, sent with every request, and a long-lived refresh token, used only
 * to get the next pair. Using a refresh token replaces the pair
 * ("rotation"), so a refresh token works once.
 *
 * Both tokens are opaque: long random strings that mean nothing by
 * themselves. The server stores only a hash of each. That makes signing out
 * immediate, which a self-contained signed token cannot be.
 */
export const SESSION_RULES = {
  /** How long an access token works. */
  accessTtlSeconds: 15 * 60,
  /** How long a refresh token works. Each rotation starts this again. */
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  /**
   * How long after a rotation the old refresh token is still accepted as a
   * retry, provided its replacement was never used. A phone on a weak
   * network can lose the reply to a refresh and ask again.
   */
  retryGraceSeconds: 30,
  /** The longest device name kept. */
  deviceNameMaxLength: 100,
} as const;

/** How the person proved who they are. */
export const SIGN_IN_METHODS = ['password', 'otp', 'passkey'] as const;

export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export const SESSION_REVOKE_REASONS = [
  /** The person signed out of this session. */
  'signed_out',
  /** The person signed out of every session. */
  'signed_out_everywhere',
  /** The password was reset or changed. */
  'password_changed',
  /** A refresh token was presented a second time: it may have been stolen. */
  'reuse_detected',
] as const;

export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

export interface Session {
  id: string;
  userId: string;
  method: SignInMethod;
  /** What the person's device calls itself, for the list of sessions. Not trusted. */
  deviceName: string | null;
  /** ISO 8601 instant of sign-in. */
  createdAt: string;
  /** ISO 8601 instant of sign-in or of the latest refresh. */
  lastUsedAt: string;
  revokedAt: string | null;
  revokeReason: SessionRevokeReason | null;
}

/** One access and refresh token pair, as stored: hashes only. */
export interface SessionTokenPair {
  id: string;
  sessionId: string;
  /** The pair this one replaced, or null for the pair issued at sign-in. */
  parentId: string | null;
  accessHash: string;
  refreshHash: string;
  issuedAt: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  /** When its refresh token was used, or when it was killed. Null while current. */
  rotatedAt: string | null;
}

const plusSeconds = (now: Date, seconds: number): string =>
  new Date(now.getTime() + seconds * 1000).toISOString();

/** When a pair issued at `now` stops working. */
export const tokenExpiries = (
  now: Date,
): { accessExpiresAt: string; refreshExpiresAt: string } => ({
  accessExpiresAt: plusSeconds(now, SESSION_RULES.accessTtlSeconds),
  refreshExpiresAt: plusSeconds(now, SESSION_RULES.refreshTtlSeconds),
});

/**
 * Whether an access token may be used. `now` is an ISO 8601 instant.
 * The caller also checks that the user may still sign in.
 */
export const isAccessLive = (
  pair: SessionTokenPair,
  session: Session,
  now: string,
): boolean =>
  session.revokedAt === null &&
  pair.sessionId === session.id &&
  pair.rotatedAt === null &&
  pair.accessExpiresAt > now;

export type RefreshVerdict =
  /** The current refresh token. Rotate it and issue the next pair. */
  | { outcome: 'rotate' }
  /**
   * The token was rotated a moment ago and its replacement was never used:
   * a retry after a lost reply. Kill the replacement and issue a new pair.
   */
  | { outcome: 'retry'; replaceId: string }
  /** The token was used before. Revoke the whole session. */
  | { outcome: 'reuse' }
  /** Unknown, expired, or its session is over. */
  | { outcome: 'invalid' };

/**
 * Judges a refresh token that was presented.
 *
 * `successor` is the pair that replaced `pair`, when there is one. The
 * function changes nothing; the caller stores what the verdict names.
 */
export const judgeRefresh = (
  pair: SessionTokenPair | null,
  session: Session | null,
  successor: SessionTokenPair | null,
  now: Date,
): RefreshVerdict => {
  if (!pair || !session || pair.sessionId !== session.id) {
    return { outcome: 'invalid' };
  }
  if (session.revokedAt !== null) {
    return { outcome: 'invalid' };
  }
  const nowIso = now.toISOString();
  if (pair.rotatedAt === null) {
    return pair.refreshExpiresAt > nowIso
      ? { outcome: 'rotate' }
      : { outcome: 'invalid' };
  }
  const graceEnds = plusSeconds(
    new Date(pair.rotatedAt),
    SESSION_RULES.retryGraceSeconds,
  );
  if (
    successor &&
    successor.parentId === pair.id &&
    successor.rotatedAt === null &&
    nowIso < graceEnds &&
    pair.refreshExpiresAt > nowIso
  ) {
    return { outcome: 'retry', replaceId: successor.id };
  }
  return { outcome: 'reuse' };
};

/**
 * Cleans the name a device gives itself: no control characters, no leading
 * or trailing space, a bounded length. Null when nothing usable is left.
 */
export const parseDeviceName = (input: unknown): string | null => {
  if (typeof input !== 'string') return null;
  const cleaned = input
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return null;
  return Array.from(cleaned)
    .slice(0, SESSION_RULES.deviceNameMaxLength)
    .join('')
    .trim();
};

// ── Password lockout ────────────────────────────────────────────────────────

export const LOCKOUT_RULES = {
  /** Wrong passwords in a row that lock password sign-in. */
  maxAttempts: 10,
  /** How long the lock lasts. */
  lockSeconds: 60 * 60,
  /** Attempts older than this no longer count. */
  windowSeconds: 60 * 60,
} as const;

/** The count of password attempts for one user since the last success. */
export interface PasswordAttempts {
  /** Attempts started and not followed by a success. */
  count: number;
  /** ISO 8601 instant of the latest attempt, or null when there is none. */
  lastAttemptAt: string | null;
  /** ISO 8601 instant until which password sign-in is locked, or null. */
  lockedUntil: string | null;
}

export const NO_PASSWORD_ATTEMPTS: PasswordAttempts = {
  count: 0,
  lastAttemptAt: null,
  lockedUntil: null,
};

export type AttemptVerdict =
  /** The password may be checked. Store `next` BEFORE checking it. */
  | { allowed: true; next: PasswordAttempts }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Decides whether a password may be checked now, and what the count becomes.
 *
 * The attempt is counted before the password is checked, and a success
 * clears the count. Counting first is what makes the limit hold when many
 * guesses arrive at once: each one must take a place before it is checked.
 */
export const judgePasswordAttempt = (
  state: PasswordAttempts,
  now: Date,
): AttemptVerdict => {
  const nowIso = now.toISOString();
  if (state.lockedUntil !== null && state.lockedUntil > nowIso) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(
        (Date.parse(state.lockedUntil) - now.getTime()) / 1000,
      ),
    };
  }
  const windowStart = plusSeconds(now, -LOCKOUT_RULES.windowSeconds);
  const stale =
    state.lastAttemptAt === null ||
    state.lastAttemptAt <= windowStart ||
    // A lock that has run out starts the count again.
    state.lockedUntil !== null;
  const count = (stale ? 0 : state.count) + 1;
  return {
    allowed: true,
    next: {
      count,
      lastAttemptAt: nowIso,
      lockedUntil:
        count >= LOCKOUT_RULES.maxAttempts
          ? plusSeconds(now, LOCKOUT_RULES.lockSeconds)
          : null,
    },
  };
};

/** How many more wrong passwords are allowed before the lock. */
export const passwordAttemptsLeft = (state: PasswordAttempts): number =>
  Math.max(0, LOCKOUT_RULES.maxAttempts - state.count);
