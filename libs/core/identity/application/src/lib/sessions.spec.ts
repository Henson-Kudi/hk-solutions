import {
  createFakeEmailSender,
  createFakeSmsSender,
  createFakeWhatsAppSender,
  createMessenger,
  type FakeSender,
} from '@hk/core/comms/application';
import type { SmsMessage } from '@hk/core/comms/domain';
import { IDENTITY_ERRORS } from '@hk/core/identity/domain';
import { sequentialIds } from '@hk/platform/test-kit';
import { FixedClock, isDomainError } from '@hk/platform/universal';
import { createAccounts, type Accounts } from './accounts';
import {
  passwordAttemptsConformance,
  sessionRepositoryConformance,
} from './conformance';
import {
  InMemoryPasswordAttemptsRepository,
  InMemorySessionRepository,
  createInMemoryIdentityStore,
  createTestOtpCodec,
  createTestTokenCodec,
  insecureTestPasswordHasher,
  type InMemoryIdentityStore,
} from './in-memory';
import type { PasswordHasher } from './ports';
import {
  SESSION_USE_CASES,
  createSessions,
  type SessionTokens,
  type Sessions,
} from './sessions';

// Every phone number, address and password in this file is invented.

const PHONE = '+237600000001';
const OTHER_PHONE = '+237600000002';
const EMAIL = 'ada@example.com';
const PASSWORD = 'Sunrise42-blue'; // gitleaks:allow (made up for the tests)
const WRONG = 'Sunrise42-grey';
const START = '2026-11-28T09:00:00.000Z';
const DAY = 24 * 60 * 60;

const failure = async (action: () => Promise<unknown>) => {
  try {
    await action();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('nothing was thrown');
};

const codeOf = async (action: () => Promise<unknown>): Promise<string> =>
  (await failure(action)).code;

describe('sessions', () => {
  let store: InMemoryIdentityStore;
  let clock: FixedClock;
  let otpCodec: ReturnType<typeof createTestOtpCodec>;
  let tokenCodec: ReturnType<typeof createTestTokenCodec>;
  let sms: FakeSender<SmsMessage>;
  let hasherCalls: { hash: number; verify: number };
  let accounts: Accounts;
  let sessions: Sessions;

  const wait = (seconds: number): void => clock.advance(seconds * 1000);
  const lastCode = (): string =>
    otpCodec.issued[otpCodec.issued.length - 1] as string;

  /** An active account with a verified phone. Returns its id. */
  const account = async (
    overrides: {
      phone?: string;
      email?: string | null;
      password?: string | null;
      name?: string;
    } = {},
  ): Promise<string> => {
    const phone = overrides.phone ?? PHONE;
    const { userId } = await accounts.signUp({
      name: overrides.name ?? 'Ada Example',
      phone,
      email: overrides.email ?? null,
      password:
        overrides.password === undefined ? PASSWORD : overrides.password,
      locale: 'en',
    });
    await accounts.verifyCode({ identifier: phone, code: lastCode() });
    return userId;
  };

  const signIn = (
    overrides: {
      identifier?: string;
      password?: string;
      deviceName?: string;
    } = {},
  ): Promise<SessionTokens> =>
    sessions.signInWithPassword({
      identifier: overrides.identifier ?? PHONE,
      password: overrides.password ?? PASSWORD,
      deviceName: overrides.deviceName,
    });

  const isLive = async (accessToken: string): Promise<boolean> => {
    try {
      await sessions.authenticate({ accessToken });
      return true;
    } catch (error) {
      if (
        isDomainError(error) &&
        error.code === IDENTITY_ERRORS.SESSION_INVALID
      ) {
        return false;
      }
      throw error;
    }
  };

  beforeEach(() => {
    store = createInMemoryIdentityStore();
    clock = new FixedClock(START);
    otpCodec = createTestOtpCodec();
    tokenCodec = createTestTokenCodec();
    sms = createFakeSmsSender(clock);
    hasherCalls = { hash: 0, verify: 0 };
    const passwordHasher: PasswordHasher = {
      hash: (password) => {
        hasherCalls.hash += 1;
        return insecureTestPasswordHasher.hash(password);
      },
      verify: (password, hash) => {
        hasherCalls.verify += 1;
        return insecureTestPasswordHasher.verify(password, hash);
      },
      needsRehash: insecureTestPasswordHasher.needsRehash,
    };
    const shared = {
      users: store.users,
      otps: store.otps,
      sessions: store.sessions,
      passwordAttempts: store.passwordAttempts,
      unitOfWork: store.unitOfWork,
      passwordHasher,
      otpCodec,
      messenger: createMessenger({
        sms,
        whatsapp: createFakeWhatsAppSender(clock),
        email: createFakeEmailSender(clock),
      }),
      clock,
      newId: sequentialIds(7),
      appName: 'HK',
    };
    accounts = createAccounts(shared);
    sessions = createSessions({ ...shared, tokenCodec });
  });

  it('declares that no session use case runs offline', () => {
    for (const useCase of Object.values(SESSION_USE_CASES)) {
      expect(useCase.offline).toBe(false);
      expect(useCase.name).toMatch(/^core\.identity\.[a-z_]+$/);
    }
    expect(Object.keys(SESSION_USE_CASES)).toHaveLength(8);
  });

  describe('signing in with a password', () => {
    it('gives an access token for 15 minutes and a refresh token for 30 days', async () => {
      const userId = await account();
      const tokens = await signIn({ deviceName: 'Till 2' });
      expect(tokens).toEqual({
        userId,
        sessionId: expect.any(String),
        accessToken: tokenCodec.issued[0],
        accessExpiresAt: '2026-11-28T09:15:00.000Z',
        refreshToken: tokenCodec.issued[1],
        refreshExpiresAt: '2026-12-28T09:00:00.000Z',
      });
      expect(tokens.accessToken).not.toBe(tokens.refreshToken);
      expect(await store.sessions.findById(tokens.sessionId)).toEqual({
        id: tokens.sessionId,
        userId,
        method: 'password',
        deviceName: 'Till 2',
        createdAt: START,
        lastUsedAt: START,
        revokedAt: null,
        revokeReason: null,
      });
    });

    it('stores hashes of the tokens, never the tokens', async () => {
      await account();
      const tokens = await signIn();
      const stored = JSON.stringify([
        store.sessions.allPairs(),
        await store.sessions.findById(tokens.sessionId),
      ]);
      expect(stored).not.toContain(tokens.accessToken);
      expect(stored).not.toContain(tokens.refreshToken);
      expect(store.sessions.allPairs()).toEqual([
        expect.objectContaining({
          accessHash: tokenCodec.hash(tokens.accessToken),
          refreshHash: tokenCodec.hash(tokens.refreshToken),
          parentId: null,
          rotatedAt: null,
        }),
      ]);
    });

    it('accepts the identifier however it is written, and a verified email too', async () => {
      await account({ email: EMAIL });
      await accounts.verifyCode({ identifier: EMAIL, code: lastCode() });
      expect((await signIn({ identifier: '+237 600 000 001' })).userId).toBe(
        (await signIn({ identifier: ' Ada@Example.com ' })).userId,
      );
    });

    it('gives each sign-in its own session', async () => {
      await account();
      const a = await signIn();
      const b = await signIn();
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(await isLive(a.accessToken)).toBe(true);
      expect(await isLive(b.accessToken)).toBe(true);
    });

    it.each<
      [string, () => Promise<{ identifier?: string; password?: string }>]
    >([
      ['a wrong password', async () => (await account(), { password: WRONG })],
      [
        'a password that differs only in case',
        async () => (await account(), { password: PASSWORD.toLowerCase() }),
      ],
      ['an identifier with no account', async () => ({})],
      [
        'an account that never verified',
        async () => {
          await accounts.signUp({
            name: 'Ada Example',
            phone: PHONE,
            password: PASSWORD,
          });
          return {};
        },
      ],
      [
        'an account that has no password',
        async () => (await account({ password: null }), {}),
      ],
      [
        'an email the account holds but never verified',
        async () => (await account({ email: EMAIL }), { identifier: EMAIL }),
      ],
      [
        'a password longer than any password can be',
        async () => (await account(), { password: 'Aa1' + 'x'.repeat(126) }),
      ],
    ])('answers %s with the one generic error', async (_name, arrange) => {
      const overrides = await arrange();
      const error = await failure(() => signIn(overrides));
      expect(error.code).toBe(IDENTITY_ERRORS.CREDENTIALS_INVALID);
      expect(error.message).toBe(
        'The phone number, email or password is not right.',
      );
      // Nothing extra that could tell the cases apart.
      expect(error.details).toEqual({});
      expect(store.sessions.allPairs()).toEqual([]);
    });

    it('rejects a malformed identifier as malformed', async () => {
      expect(await codeOf(() => signIn({ identifier: 'not-a-phone' }))).toBe(
        IDENTITY_ERRORS.IDENTIFIER_INVALID,
      );
    });

    it('does the work of checking a password even when there is no account', async () => {
      // Otherwise "no account" would answer faster than "wrong password".
      await failure(() => signIn());
      expect(hasherCalls.verify).toBe(1);
      await failure(() => signIn({ identifier: OTHER_PHONE }));
      expect(hasherCalls.verify).toBe(2);
      // The decoy is hashed once, not on every request.
      expect(hasherCalls.hash).toBe(1);
    });

    it('does not hash a password too long to be one', async () => {
      await account();
      const before = { ...hasherCalls };
      await failure(() => signIn({ password: 'x'.repeat(100_000) }));
      expect(hasherCalls).toEqual(before);
    });

    it('tells a suspended person so, but only once they prove the password', async () => {
      const userId = await account();
      store.users.setStatus(userId, 'suspended');
      expect(await codeOf(() => signIn({ password: WRONG }))).toBe(
        IDENTITY_ERRORS.CREDENTIALS_INVALID,
      );
      const error = await failure(() => signIn());
      expect(error.code).toBe(IDENTITY_ERRORS.ACCOUNT_UNAVAILABLE);
      expect(error.kind).toBe('forbidden');
      expect(store.sessions.allPairs()).toEqual([]);
    });

    it('replaces a hash made with weaker settings, at a successful sign-in only', async () => {
      const userId = await account();
      await store.users.setPasswordHash(userId, `test-old-hash:${PASSWORD}`);
      await failure(() => signIn({ password: WRONG }));
      expect(await store.users.passwordHashOf(userId)).toBe(
        `test-old-hash:${PASSWORD}`,
      );
      await signIn();
      expect(await store.users.passwordHashOf(userId)).toBe(
        `test-hash:${PASSWORD}`,
      );
      // And the new hash is left alone the next time.
      const hashed = hasherCalls.hash;
      await signIn();
      expect(hasherCalls.hash).toBe(hashed);
    });
  });

  describe('lockout', () => {
    const wrongTimes = async (times: number): Promise<string[]> => {
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < times; attempt += 1) {
        outcomes.push(await codeOf(() => signIn({ password: WRONG })));
      }
      return outcomes;
    };

    it('keeps the count although every wrong attempt ends in an error', async () => {
      const userId = await account();
      await wrongTimes(3);
      expect(await store.passwordAttempts.read(userId)).toEqual({
        count: 3,
        lastAttemptAt: START,
        lockedUntil: null,
      });
    });

    it('locks password sign-in for an hour after ten wrong passwords', async () => {
      await account();
      expect(await wrongTimes(10)).toEqual(
        new Array(10).fill(IDENTITY_ERRORS.CREDENTIALS_INVALID),
      );
      const locked = await failure(() => signIn());
      expect(locked.code).toBe(IDENTITY_ERRORS.ACCOUNT_LOCKED);
      expect(locked.kind).toBe('forbidden');
      expect(locked.details).toEqual({ retryAfterSeconds: 3600 });
      expect(store.sessions.allPairs()).toEqual([]);

      wait(3599);
      expect((await failure(() => signIn())).details).toEqual({
        retryAfterSeconds: 1,
      });
      wait(1);
      expect((await signIn()).accessToken).toBeDefined();
    });

    it('does not check the password at all while locked', async () => {
      await account();
      await wrongTimes(10);
      const before = hasherCalls.verify;
      await failure(() => signIn());
      expect(hasherCalls.verify).toBe(before);
    });

    it('forgets the count at a right password', async () => {
      const userId = await account();
      await wrongTimes(9);
      await signIn();
      expect((await store.passwordAttempts.read(userId)).count).toBe(0);
      // Nine more wrong ones would have locked it had the count been kept.
      expect(await wrongTimes(9)).not.toContain(IDENTITY_ERRORS.ACCOUNT_LOCKED);
      expect((await signIn()).accessToken).toBeDefined();
    });

    it('lets the tenth attempt in when it is right', async () => {
      await account();
      await wrongTimes(9);
      expect((await signIn()).accessToken).toBeDefined();
    });

    it('forgets wrong passwords more than an hour old', async () => {
      await account();
      await wrongTimes(9);
      wait(3600);
      expect(await wrongTimes(9)).not.toContain(IDENTITY_ERRORS.ACCOUNT_LOCKED);
    });

    it('still lets the person in with a code while the password is locked', async () => {
      const userId = await account();
      await wrongTimes(10);
      await sessions.requestSignInCode({ identifier: PHONE });
      const tokens = await sessions.signInWithCode({
        identifier: PHONE,
        code: lastCode(),
      });
      expect(tokens.userId).toBe(userId);
    });

    it('is lifted by a password reset', async () => {
      await account();
      await wrongTimes(10);
      await accounts.requestPasswordReset({ identifier: PHONE });
      await accounts.resetPassword({
        identifier: PHONE,
        code: lastCode(),
        newPassword: 'Brand-new-Pass9',
      });
      expect(
        (await signIn({ password: 'Brand-new-Pass9' })).accessToken,
      ).toBeDefined();
    });

    it('locks one account and not another', async () => {
      await account();
      await account({ phone: OTHER_PHONE, name: 'Ben Example' });
      await wrongTimes(10);
      expect(
        (await signIn({ identifier: OTHER_PHONE })).accessToken,
      ).toBeDefined();
    });

    it('never locks an identifier that has no account', async () => {
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        outcomes.push(await codeOf(() => signIn()));
      }
      expect(new Set(outcomes)).toEqual(
        new Set([IDENTITY_ERRORS.CREDENTIALS_INVALID]),
      );
    });
  });

  describe('signing in with a code', () => {
    it('sends a sign-in code and starts a session with it', async () => {
      const userId = await account({ password: null });
      const sent = await sessions.requestSignInCode({ identifier: PHONE });
      expect(sent).toEqual({
        kind: 'phone',
        destination: '+237•••••001',
        channel: 'sms',
        expiresAt: '2026-11-28T09:10:00.000Z',
      });
      expect(sms.last()?.text).toBe(
        `HK: your sign-in code is ${lastCode()}. Valid for 10 minutes. Do not share it.`,
      );
      const tokens = await sessions.signInWithCode({
        identifier: PHONE,
        code: lastCode(),
        deviceName: 'Samsung A14',
      });
      expect(tokens.userId).toBe(userId);
      expect(await store.sessions.findById(tokens.sessionId)).toMatchObject({
        method: 'otp',
        deviceName: 'Samsung A14',
      });
      expect(await isLive(tokens.accessToken)).toBe(true);
    });

    it('works once', async () => {
      await account();
      await sessions.requestSignInCode({ identifier: PHONE });
      const code = lastCode();
      await sessions.signInWithCode({ identifier: PHONE, code });
      expect(
        await codeOf(() =>
          sessions.signInWithCode({ identifier: PHONE, code }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
      expect(store.sessions.allPairs()).toHaveLength(1);
    });

    it('counts a wrong code and starts no session', async () => {
      await account();
      await sessions.requestSignInCode({ identifier: PHONE });
      const error = await failure(() =>
        sessions.signInWithCode({ identifier: PHONE, code: '000000' }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.OTP_INVALID);
      expect(error.details).toEqual({ attemptsLeft: 4 });
      expect(store.sessions.allPairs()).toEqual([]);
    });

    it.each<[string, () => Promise<void>]>([
      ['an identifier with no account', async () => undefined],
      [
        'an account that never verified',
        async () => {
          await accounts.signUp({ name: 'Ada Example', phone: PHONE });
          wait(120);
        },
      ],
      [
        'a suspended account',
        async () => {
          store.users.setStatus(await account(), 'suspended');
        },
      ],
    ])(
      'answers a request for %s as if a code was sent, and sends none',
      async (_name, arrange) => {
        await arrange();
        const sentBefore = sms.sent.length;
        const sent = await sessions.requestSignInCode({ identifier: PHONE });
        expect(sent).toEqual({
          kind: 'phone',
          destination: '+237•••••001',
          channel: 'sms',
          expiresAt: new Date(clock.now().getTime() + 600_000).toISOString(),
        });
        expect(sms.sent).toHaveLength(sentBefore);
        expect(store.otps.all().some((code) => code.purpose === 'login')).toBe(
          false,
        );
        expect(
          await codeOf(() =>
            sessions.signInWithCode({ identifier: PHONE, code: '123456' }),
          ),
        ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
      },
    );

    it('does not accept a password reset code as a sign-in code, or the reverse', async () => {
      await account();
      await accounts.requestPasswordReset({ identifier: PHONE });
      const resetCode = lastCode();
      expect(
        await codeOf(() =>
          sessions.signInWithCode({ identifier: PHONE, code: resetCode }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);

      await sessions.requestSignInCode({ identifier: PHONE });
      const signInCode = lastCode();
      // Checked against the live reset code: it is simply a wrong code there.
      expect(
        await codeOf(() =>
          accounts.resetPassword({
            identifier: PHONE,
            code: signInCode,
            newPassword: 'Brand-new-Pass9',
          }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_INVALID);
      expect(store.sessions.allPairs()).toEqual([]);
    });

    it('applies the resend limits to sign-in codes', async () => {
      await account();
      await sessions.requestSignInCode({ identifier: PHONE });
      expect(
        await codeOf(() => sessions.requestSignInCode({ identifier: PHONE })),
      ).toBe(IDENTITY_ERRORS.OTP_RESEND_TOO_SOON);
    });
  });

  describe('authenticating a request', () => {
    it('says who an access token belongs to', async () => {
      const userId = await account();
      const tokens = await signIn();
      wait(60);
      expect(
        await sessions.authenticate({ accessToken: tokens.accessToken }),
      ).toEqual({
        userId,
        sessionId: tokens.sessionId,
        method: 'password',
        signedInAt: START,
        accessExpiresAt: '2026-11-28T09:15:00.000Z',
      });
    });

    it('stops accepting an access token at 15 minutes exactly', async () => {
      await account();
      const tokens = await signIn();
      wait(899);
      expect(await isLive(tokens.accessToken)).toBe(true);
      wait(1);
      expect(await isLive(tokens.accessToken)).toBe(false);
    });

    it('does not accept a refresh token as an access token', async () => {
      await account();
      const tokens = await signIn();
      expect(await isLive(tokens.refreshToken)).toBe(false);
    });

    it.each<[string, unknown]>([
      ['an unknown token', 'test-access-token-9999'],
      ['an empty string', ''],
      ['a short string', 'abc'],
      ['a very long string', 'a'.repeat(5000)],
      ['nothing', undefined],
      ['a number', 1234567890],
      ['an object', { token: 'test-access-token-0001' }],
    ])('refuses %s', async (_name, accessToken) => {
      await account();
      await signIn();
      const error = await failure(() =>
        sessions.authenticate({ accessToken: accessToken as string }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.SESSION_INVALID);
      expect(error.kind).toBe('forbidden');
    });

    it('cuts a suspended person off at once, and lets them back when reinstated', async () => {
      const userId = await account();
      const tokens = await signIn();
      store.users.setStatus(userId, 'suspended');
      expect(await isLive(tokens.accessToken)).toBe(false);
      store.users.setStatus(userId, 'active');
      expect(await isLive(tokens.accessToken)).toBe(true);
    });
  });

  describe('refreshing', () => {
    it('gives a new pair and stops the old one working', async () => {
      await account();
      const first = await signIn();
      wait(600);
      const second = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      expect(second).toEqual({
        userId: first.userId,
        sessionId: first.sessionId,
        accessToken: expect.any(String),
        accessExpiresAt: '2026-11-28T09:25:00.000Z',
        refreshToken: expect.any(String),
        refreshExpiresAt: '2026-12-28T09:10:00.000Z',
      });
      expect(second.accessToken).not.toBe(first.accessToken);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      // The old access token had five minutes left; it is dead all the same.
      expect(await isLive(first.accessToken)).toBe(false);
      expect(await isLive(second.accessToken)).toBe(true);
      expect((await store.sessions.findById(first.sessionId))?.lastUsedAt).toBe(
        '2026-11-28T09:10:00.000Z',
      );
    });

    it('works after the access token has expired, for 30 days and no longer', async () => {
      await account();
      const first = await signIn();
      wait(30 * DAY - 1);
      const second = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      wait(30 * DAY);
      expect(
        await codeOf(() =>
          sessions.refresh({ refreshToken: second.refreshToken }),
        ),
      ).toBe(IDENTITY_ERRORS.SESSION_INVALID);
    });

    it('keeps a session alive for as long as it is used', async () => {
      await account();
      let tokens = await signIn();
      for (let week = 0; week < 10; week += 1) {
        wait(7 * DAY);
        tokens = await sessions.refresh({ refreshToken: tokens.refreshToken });
      }
      expect(await isLive(tokens.accessToken)).toBe(true);
    });

    it('ends the whole session when a used refresh token comes back', async () => {
      await account();
      const first = await signIn();
      const second = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      wait(31);
      // Someone presents the first token again: thief or owner, one of them
      // holds a copy they should not.
      const error = await failure(() =>
        sessions.refresh({ refreshToken: first.refreshToken }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.SESSION_INVALID);
      // The session is over although the request that ended it failed.
      expect(await store.sessions.findById(first.sessionId)).toMatchObject({
        revokedAt: '2026-11-28T09:00:31.000Z',
        revokeReason: 'reuse_detected',
      });
      expect(await isLive(second.accessToken)).toBe(false);
      expect(
        await codeOf(() =>
          sessions.refresh({ refreshToken: second.refreshToken }),
        ),
      ).toBe(IDENTITY_ERRORS.SESSION_INVALID);
    });

    it('ends only that session, not the person’s others', async () => {
      await account();
      const stolen = await signIn();
      const other = await signIn();
      await sessions.refresh({ refreshToken: stolen.refreshToken });
      wait(31);
      await failure(() =>
        sessions.refresh({ refreshToken: stolen.refreshToken }),
      );
      expect(await isLive(other.accessToken)).toBe(true);
    });

    it('treats a repeat within 30 seconds as a retry when the new pair was never used', async () => {
      await account();
      const first = await signIn();
      // The reply to this refresh is "lost": the device never sees `lost`.
      const lost = await sessions.refresh({ refreshToken: first.refreshToken });
      wait(29);
      const retried = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      expect(retried.sessionId).toBe(first.sessionId);
      expect(await isLive(retried.accessToken)).toBe(true);
      // The pair nobody received is dead.
      expect(await isLive(lost.accessToken)).toBe(false);
      expect(
        (await store.sessions.findById(first.sessionId))?.revokedAt,
      ).toBeNull();
      // And the session carries on from the retried pair.
      const next = await sessions.refresh({
        refreshToken: retried.refreshToken,
      });
      expect(await isLive(next.accessToken)).toBe(true);
    });

    it('allows a second retry in the window', async () => {
      await account();
      const first = await signIn();
      await sessions.refresh({ refreshToken: first.refreshToken });
      wait(10);
      await sessions.refresh({ refreshToken: first.refreshToken });
      wait(10);
      const third = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      expect(await isLive(third.accessToken)).toBe(true);
    });

    it('ends the session if the pair killed by a retry is used after all', async () => {
      await account();
      const first = await signIn();
      const killed = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      wait(5);
      const retried = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      // Two parties now hold pairs from one token. Whoever holds the killed
      // one shows themselves by using it.
      expect(
        await codeOf(() =>
          sessions.refresh({ refreshToken: killed.refreshToken }),
        ),
      ).toBe(IDENTITY_ERRORS.SESSION_INVALID);
      expect(
        (await store.sessions.findById(first.sessionId))?.revokeReason,
      ).toBe('reuse_detected');
      expect(await isLive(retried.accessToken)).toBe(false);
    });

    it('does not treat a repeat as a retry once the new pair has been used', async () => {
      await account();
      const first = await signIn();
      const second = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      const third = await sessions.refresh({
        refreshToken: second.refreshToken,
      });
      wait(5);
      expect(
        await codeOf(() =>
          sessions.refresh({ refreshToken: first.refreshToken }),
        ),
      ).toBe(IDENTITY_ERRORS.SESSION_INVALID);
      expect(await isLive(third.accessToken)).toBe(false);
    });

    it('does not accept an access token as a refresh token', async () => {
      await account();
      const tokens = await signIn();
      expect(
        await codeOf(() =>
          sessions.refresh({ refreshToken: tokens.accessToken }),
        ),
      ).toBe(IDENTITY_ERRORS.SESSION_INVALID);
      // And that mistake costs nothing: the session is untouched.
      expect(await isLive(tokens.accessToken)).toBe(true);
    });

    it.each([
      ['unknown', 'test-refresh-token-9999'],
      ['empty', ''],
      ['huge', 'r'.repeat(5000)],
    ])('refuses an %s token', async (_name, refreshToken) => {
      expect(await codeOf(() => sessions.refresh({ refreshToken }))).toBe(
        IDENTITY_ERRORS.SESSION_INVALID,
      );
    });

    it('gives a suspended person no new pair, and does not burn their token', async () => {
      const userId = await account();
      const tokens = await signIn();
      store.users.setStatus(userId, 'suspended');
      expect(
        await codeOf(() =>
          sessions.refresh({ refreshToken: tokens.refreshToken }),
        ),
      ).toBe(IDENTITY_ERRORS.SESSION_INVALID);
      expect(store.sessions.allPairs()).toHaveLength(1);
      store.users.setStatus(userId, 'active');
      const next = await sessions.refresh({
        refreshToken: tokens.refreshToken,
      });
      expect(await isLive(next.accessToken)).toBe(true);
    });
  });

  describe('signing out', () => {
    it('ends that session and leaves the others', async () => {
      const userId = await account();
      const phone = await signIn({ deviceName: 'Phone' });
      const till = await signIn({ deviceName: 'Till' });
      await sessions.signOut({ userId, sessionId: phone.sessionId });
      expect(await isLive(phone.accessToken)).toBe(false);
      expect(await isLive(till.accessToken)).toBe(true);
      expect(
        await codeOf(() =>
          sessions.refresh({ refreshToken: phone.refreshToken }),
        ),
      ).toBe(IDENTITY_ERRORS.SESSION_INVALID);
      expect(await store.sessions.findById(phone.sessionId)).toMatchObject({
        revokedAt: START,
        revokeReason: 'signed_out',
      });
    });

    it('can be repeated, and ignores a session that does not exist', async () => {
      const userId = await account();
      const tokens = await signIn();
      await sessions.signOut({ userId, sessionId: tokens.sessionId });
      wait(60);
      await sessions.signOut({ userId, sessionId: tokens.sessionId });
      await sessions.signOut({ userId, sessionId: 'no-such-session' });
      expect((await store.sessions.findById(tokens.sessionId))?.revokedAt).toBe(
        START,
      );
    });

    it('cannot end another person’s session', async () => {
      await account();
      const intruder = await account({
        phone: OTHER_PHONE,
        name: 'Ben Example',
      });
      const tokens = await signIn();
      await sessions.signOut({ userId: intruder, sessionId: tokens.sessionId });
      expect(await isLive(tokens.accessToken)).toBe(true);
    });

    it('signs out everywhere, or everywhere else', async () => {
      const userId = await account();
      await account({ phone: OTHER_PHONE, name: 'Ben Example' });
      const a = await signIn();
      const b = await signIn();
      const c = await signIn();
      const theirs = await signIn({ identifier: OTHER_PHONE });

      expect(
        await sessions.signOutEverywhere({
          userId,
          exceptSessionId: b.sessionId,
        }),
      ).toEqual({ ended: 2 });
      expect(
        await Promise.all([a, b, c, theirs].map((t) => isLive(t.accessToken))),
      ).toEqual([false, true, false, true]);

      expect(await sessions.signOutEverywhere({ userId })).toEqual({
        ended: 1,
      });
      expect(await isLive(b.accessToken)).toBe(false);
      expect(await isLive(theirs.accessToken)).toBe(true);
    });

    it('ends every session when the password is reset', async () => {
      await account();
      const a = await signIn();
      const b = await signIn();
      wait(120);
      await accounts.requestPasswordReset({ identifier: PHONE });
      await accounts.resetPassword({
        identifier: PHONE,
        code: lastCode(),
        newPassword: 'Brand-new-Pass9',
      });
      expect(await isLive(a.accessToken)).toBe(false);
      expect(await isLive(b.accessToken)).toBe(false);
      expect((await store.sessions.findById(a.sessionId))?.revokeReason).toBe(
        'password_changed',
      );
    });

    it('keeps sessions when a reset fails on a wrong code', async () => {
      await account();
      const tokens = await signIn();
      await accounts.requestPasswordReset({ identifier: PHONE });
      await failure(() =>
        accounts.resetPassword({
          identifier: PHONE,
          code: '000000',
          newPassword: 'Brand-new-Pass9',
        }),
      );
      expect(await isLive(tokens.accessToken)).toBe(true);
    });

    it('ends the other sessions when the password is changed, keeping the current one', async () => {
      const userId = await account();
      const current = await signIn();
      const other = await signIn();
      await accounts.changePassword({
        userId,
        currentPassword: PASSWORD,
        newPassword: 'Brand-new-Pass9',
        keepSessionId: current.sessionId,
      });
      expect(await isLive(current.accessToken)).toBe(true);
      expect(await isLive(other.accessToken)).toBe(false);
    });

    it('ends every session when the password is changed and none is named', async () => {
      const userId = await account();
      const tokens = await signIn();
      await accounts.changePassword({
        userId,
        currentPassword: PASSWORD,
        newPassword: 'Brand-new-Pass9',
      });
      expect(await isLive(tokens.accessToken)).toBe(false);
    });
  });

  describe('listing sessions', () => {
    it('lists the live sessions, most recently used first, marking the current one', async () => {
      const userId = await account();
      await account({ phone: OTHER_PHONE, name: 'Ben Example' });
      const phone = await signIn({ deviceName: '  My\tphone‮ ' });
      wait(60);
      const till = await signIn({ deviceName: 'Till 2' });
      await signIn({ identifier: OTHER_PHONE });
      wait(60);
      await sessions.requestSignInCode({ identifier: PHONE });
      const gone = await sessions.signInWithCode({
        identifier: PHONE,
        code: lastCode(),
      });
      await sessions.signOut({ userId, sessionId: gone.sessionId });

      expect(
        await sessions.listSessions({
          userId,
          currentSessionId: phone.sessionId,
        }),
      ).toEqual([
        {
          id: till.sessionId,
          method: 'password',
          deviceName: 'Till 2',
          createdAt: '2026-11-28T09:01:00.000Z',
          lastUsedAt: '2026-11-28T09:01:00.000Z',
          current: false,
        },
        {
          id: phone.sessionId,
          method: 'password',
          deviceName: 'My phone',
          createdAt: START,
          lastUsedAt: START,
          current: true,
        },
      ]);

      wait(60);
      await sessions.refresh({ refreshToken: phone.refreshToken });
      const listed = await sessions.listSessions({ userId });
      expect(listed.map((session) => session.id)).toEqual([
        phone.sessionId,
        till.sessionId,
      ]);
      expect(listed.every((session) => !session.current)).toBe(true);
    });

    it('drops a session nobody has used for 30 days', async () => {
      const userId = await account();
      await signIn();
      wait(30 * DAY);
      expect(await sessions.listSessions({ userId })).toEqual([]);
    });

    it('never shows a token or a hash', async () => {
      const userId = await account();
      const tokens = await signIn();
      const listed = JSON.stringify(await sessions.listSessions({ userId }));
      expect(listed).not.toContain(tokens.accessToken);
      expect(listed).not.toContain(tokens.refreshToken);
      expect(listed).not.toContain(tokenCodec.hash(tokens.accessToken));
      expect(listed).not.toContain(tokenCodec.hash(tokens.refreshToken));
    });
  });

  describe('privacy', () => {
    it('never puts a token, a password, a phone number or a code in an error', async () => {
      await account();
      const tokens = await signIn();
      await sessions.refresh({ refreshToken: tokens.refreshToken });
      await sessions.requestSignInCode({ identifier: PHONE });
      const code = lastCode();
      const errors = [
        await failure(() => signIn({ password: WRONG })),
        await failure(() => signIn({ identifier: OTHER_PHONE })),
        await failure(() =>
          sessions.authenticate({ accessToken: tokens.accessToken }),
        ),
        await failure(() =>
          sessions.signInWithCode({ identifier: PHONE, code: '000000' }),
        ),
        await failure(() => sessions.requestSignInCode({ identifier: PHONE })),
      ];
      wait(31);
      errors.push(
        await failure(() =>
          sessions.refresh({ refreshToken: tokens.refreshToken }),
        ),
      );
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await failure(() => signIn({ password: WRONG }));
      }
      errors.push(await failure(() => signIn()));
      expect(errors.map((error) => error.code)).toEqual([
        IDENTITY_ERRORS.CREDENTIALS_INVALID,
        IDENTITY_ERRORS.CREDENTIALS_INVALID,
        IDENTITY_ERRORS.SESSION_INVALID,
        IDENTITY_ERRORS.OTP_INVALID,
        IDENTITY_ERRORS.OTP_RESEND_TOO_SOON,
        IDENTITY_ERRORS.SESSION_INVALID,
        IDENTITY_ERRORS.ACCOUNT_LOCKED,
      ]);
      for (const error of errors) {
        const text = `${error.message} ${JSON.stringify(error.toJSON())}`;
        expect(text).not.toMatch(
          /600000001|600000002|test-(access|refresh)-token/,
        );
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(WRONG);
        expect(text).not.toContain(code);
      }
    });

    it('gives the same answer for every kind of dead session token', async () => {
      const userId = await account();
      const signedOut = await signIn();
      const expired = await signIn();
      await sessions.signOut({ userId, sessionId: signedOut.sessionId });
      wait(900);
      const answers = await Promise.all(
        [
          signedOut.accessToken,
          expired.accessToken,
          'test-access-token-9999',
        ].map(async (accessToken) => {
          const error = await failure(() =>
            sessions.authenticate({ accessToken }),
          );
          return JSON.stringify(error.toJSON());
        }),
      );
      expect(new Set(answers).size).toBe(1);
    });
  });
});

describe('InMemorySessionRepository conformance', () => {
  for (const testCase of sessionRepositoryConformance) {
    it(testCase.name, () =>
      testCase.run({
        sessions: new InMemorySessionRepository(),
        within: (action) => action(),
        ensureUser: async () => undefined,
      }),
    );
  }
});

describe('InMemoryPasswordAttemptsRepository conformance', () => {
  for (const testCase of passwordAttemptsConformance) {
    it(testCase.name, () =>
      testCase.run({
        passwordAttempts: new InMemoryPasswordAttemptsRepository(),
        within: (action) => action(),
        ensureUser: async () => undefined,
      }),
    );
  }
});
