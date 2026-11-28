import {
  LOCKOUT_RULES,
  NO_PASSWORD_ATTEMPTS,
  SESSION_RULES,
  isAccessLive,
  judgePasswordAttempt,
  judgeRefresh,
  parseDeviceName,
  passwordAttemptsLeft,
  tokenExpiries,
  type PasswordAttempts,
  type Session,
  type SessionTokenPair,
} from './session';

const NOW = new Date('2026-11-28T09:00:00.000Z');
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);
const iso = (seconds: number): string => at(seconds).toISOString();

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  userId: 'user-1',
  method: 'password',
  deviceName: null,
  createdAt: iso(-3600),
  lastUsedAt: iso(-3600),
  revokedAt: null,
  revokeReason: null,
  ...overrides,
});

const pair = (overrides: Partial<SessionTokenPair> = {}): SessionTokenPair => ({
  id: 'pair-1',
  sessionId: 'session-1',
  parentId: null,
  accessHash: 'access-hash-1',
  refreshHash: 'refresh-hash-1',
  issuedAt: iso(-60),
  accessExpiresAt: iso(840),
  refreshExpiresAt: iso(86_400),
  rotatedAt: null,
  ...overrides,
});

describe('session rules', () => {
  it('are the agreed values', () => {
    expect(SESSION_RULES).toEqual({
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
      retryGraceSeconds: 30,
      deviceNameMaxLength: 100,
    });
    expect(LOCKOUT_RULES).toEqual({
      maxAttempts: 10,
      lockSeconds: 3600,
      windowSeconds: 3600,
    });
  });

  it('gives an access token 15 minutes and a refresh token 30 days', () => {
    expect(tokenExpiries(NOW)).toEqual({
      accessExpiresAt: '2026-11-28T09:15:00.000Z',
      refreshExpiresAt: '2026-12-28T09:00:00.000Z',
    });
  });
});

describe('isAccessLive', () => {
  it('accepts a current pair of a live session', () => {
    expect(isAccessLive(pair(), session(), iso(0))).toBe(true);
  });

  it('stops at the expiry instant, not after it', () => {
    expect(isAccessLive(pair(), session(), iso(839))).toBe(true);
    expect(isAccessLive(pair(), session(), iso(840))).toBe(false);
  });

  it.each<[string, Partial<SessionTokenPair>, Partial<Session>]>([
    [
      'a revoked session',
      {},
      { revokedAt: iso(-1), revokeReason: 'signed_out' },
    ],
    ['a pair that was rotated', { rotatedAt: iso(-1) }, {}],
    ['a pair of another session', { sessionId: 'session-2' }, {}],
  ])('refuses %s', (_name, pairOverrides, sessionOverrides) => {
    expect(
      isAccessLive(pair(pairOverrides), session(sessionOverrides), iso(0)),
    ).toBe(false);
  });
});

describe('judgeRefresh', () => {
  const rotated = pair({ rotatedAt: iso(-10) });
  const successor = pair({
    id: 'pair-2',
    parentId: 'pair-1',
    accessHash: 'access-hash-2',
    refreshHash: 'refresh-hash-2',
    issuedAt: iso(-10),
  });

  it('rotates the current token', () => {
    expect(judgeRefresh(pair(), session(), null, NOW)).toEqual({
      outcome: 'rotate',
    });
  });

  it('still rotates a token whose access token has expired', () => {
    expect(
      judgeRefresh(pair({ accessExpiresAt: iso(-1) }), session(), null, NOW),
    ).toEqual({ outcome: 'rotate' });
  });

  it.each<[string, SessionTokenPair | null, Session | null]>([
    ['an unknown token', null, null],
    ['a token with no session', pair(), null],
    ['a token of another session', pair({ sessionId: 'session-2' }), session()],
    ['an expired token', pair({ refreshExpiresAt: iso(0) }), session()],
    [
      'a token of a revoked session',
      pair(),
      session({ revokedAt: iso(-5), revokeReason: 'signed_out' }),
    ],
    [
      // Not "reuse": the session is over already, there is nothing to revoke.
      'a rotated token of a revoked session',
      rotated,
      session({ revokedAt: iso(-5), revokeReason: 'reuse_detected' }),
    ],
  ])('calls %s invalid', (_name, presented, itsSession) => {
    expect(judgeRefresh(presented, itsSession, null, NOW)).toEqual({
      outcome: 'invalid',
    });
  });

  it('treats a rotated token as a retry within 30 seconds when its replacement is unused', () => {
    expect(judgeRefresh(rotated, session(), successor, NOW)).toEqual({
      outcome: 'retry',
      replaceId: 'pair-2',
    });
  });

  it('ends the retry window at 30 seconds exactly', () => {
    const justInside = pair({ rotatedAt: iso(-29) });
    const atTheEdge = pair({ rotatedAt: iso(-30) });
    expect(judgeRefresh(justInside, session(), successor, NOW).outcome).toBe(
      'retry',
    );
    expect(judgeRefresh(atTheEdge, session(), successor, NOW).outcome).toBe(
      'reuse',
    );
  });

  it.each<[string, SessionTokenPair | null]>([
    ['its replacement was used', { ...successor, rotatedAt: iso(-2) }],
    ['there is no replacement on record', null],
    [
      'the "replacement" replaced another pair',
      { ...successor, parentId: 'pair-0' },
    ],
  ])('calls a rotated token reuse when %s', (_name, itsSuccessor) => {
    expect(judgeRefresh(rotated, session(), itsSuccessor, NOW)).toEqual({
      outcome: 'reuse',
    });
  });

  it('calls a token rotated long ago reuse', () => {
    expect(
      judgeRefresh(
        pair({ rotatedAt: iso(-86_400) }),
        session(),
        successor,
        NOW,
      ),
    ).toEqual({ outcome: 'reuse' });
  });

  it('calls a rotated token that has also expired reuse, not a retry', () => {
    expect(
      judgeRefresh(
        pair({ rotatedAt: iso(-10), refreshExpiresAt: iso(-1) }),
        session(),
        successor,
        NOW,
      ),
    ).toEqual({ outcome: 'reuse' });
  });
});

describe('parseDeviceName', () => {
  it.each<[unknown, string | null]>([
    ['Till 2, Akwa shop', 'Till 2, Akwa shop'],
    ['  Samsung   A14  ', 'Samsung A14'],
    ['Caisse\n\tprincipale\u0000', 'Caisse principale'],
    // A right-to-left override could make a name display as something else.
    ['Phone‮​X', 'Phone X'],
    ['هاتف المتجر', 'هاتف المتجر'],
    ['', null],
    ['   ', null],
    ['\u0000\u0007', null],
    [undefined, null],
    [null, null],
    [42, null],
    [{ name: 'x' }, null],
  ])('%j becomes %j', (input, expected) => {
    expect(parseDeviceName(input)).toBe(expected);
  });

  it('keeps at most 100 characters, counting an emoji as one', () => {
    expect(parseDeviceName('a'.repeat(250))).toHaveLength(100);
    const emoji = parseDeviceName('😀'.repeat(150)) as string;
    expect(Array.from(emoji)).toHaveLength(100);
    // No half character at the cut.
    expect(emoji.endsWith('😀')).toBe(true);
  });
});

describe('judgePasswordAttempt', () => {
  /** Makes `n` attempts one second apart, starting at `from` seconds. */
  const after = (n: number, from = 0): PasswordAttempts => {
    let state = NO_PASSWORD_ATTEMPTS;
    for (let index = 0; index < n; index += 1) {
      const verdict = judgePasswordAttempt(state, at(from + index));
      if (!verdict.allowed) throw new Error('unexpectedly locked');
      state = verdict.next;
    }
    return state;
  };

  it('counts the first attempt', () => {
    expect(judgePasswordAttempt(NO_PASSWORD_ATTEMPTS, NOW)).toEqual({
      allowed: true,
      next: { count: 1, lastAttemptAt: iso(0), lockedUntil: null },
    });
  });

  it('allows the tenth attempt, and locks as it is counted', () => {
    const nine = after(9);
    expect(nine).toMatchObject({ count: 9, lockedUntil: null });
    expect(passwordAttemptsLeft(nine)).toBe(1);
    const tenth = judgePasswordAttempt(nine, at(9));
    expect(tenth).toEqual({
      allowed: true,
      next: { count: 10, lastAttemptAt: iso(9), lockedUntil: iso(3609) },
    });
  });

  it('refuses the eleventh, and says how long to wait', () => {
    const ten = after(10);
    expect(passwordAttemptsLeft(ten)).toBe(0);
    expect(judgePasswordAttempt(ten, at(10))).toEqual({
      allowed: false,
      retryAfterSeconds: 3599,
    });
    expect(judgePasswordAttempt(ten, at(3608))).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it('rounds the wait up, so "retry after" is never too early', () => {
    const ten = after(10);
    const verdict = judgePasswordAttempt(
      ten,
      new Date(at(3608).getTime() + 400),
    );
    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('allows an attempt again when the lock runs out, counting from one', () => {
    const ten = after(10);
    expect(judgePasswordAttempt(ten, at(3609))).toEqual({
      allowed: true,
      next: { count: 1, lastAttemptAt: iso(3609), lockedUntil: null },
    });
  });

  it('forgets attempts more than an hour old', () => {
    const nine = after(9);
    // The latest was at second 8; an hour later it no longer counts.
    expect(judgePasswordAttempt(nine, at(3607))).toMatchObject({
      next: { count: 10 },
    });
    expect(judgePasswordAttempt(nine, at(3608))).toMatchObject({
      next: { count: 1, lockedUntil: null },
    });
  });

  it('never goes below zero attempts left', () => {
    expect(
      passwordAttemptsLeft({
        count: 25,
        lastAttemptAt: iso(0),
        lockedUntil: null,
      }),
    ).toBe(0);
    expect(passwordAttemptsLeft(NO_PASSWORD_ATTEMPTS)).toBe(10);
  });
});
