import { createHash } from 'node:crypto';
import {
  createFakeEmailSender,
  createFakeSmsSender,
  createFakeWhatsAppSender,
  createMessenger,
} from '@hk/core/comms/application';
import {
  createAccounts,
  createSessions,
  createTestOtpCodec,
  insecureTestPasswordHasher,
  passwordAttemptsConformance,
  sessionRepositoryConformance,
  type Accounts,
  type SessionTokens,
  type Sessions,
} from '@hk/core/identity/application';
import { IDENTITY_ERRORS } from '@hk/core/identity/domain';
import {
  createDatabase,
  requireSystemTransaction,
  withSystemTransaction,
  type Database,
} from '@hk/platform/db';
import {
  createTestSchema,
  postgresTestUrl,
  type TestSchema,
} from '@hk/platform/testing';
import {
  FixedClock,
  createUuidV7Generator,
  isDomainError,
} from '@hk/platform/universal';
import { sql } from 'drizzle-orm';
import {
  TOKEN_PREFIXES,
  createArgon2idPasswordHasher,
  createNodeTokenCodec,
} from './node-crypto';
import {
  PgOtpRepository,
  PgPasswordAttemptsRepository,
  PgSessionRepository,
  PgUserRepository,
  createPgIdentityUnitOfWork,
} from './pg-repositories';
import { identityTables, type IdentityTables } from './schema';

// Every phone number, address, password and token in this file is invented.
const INVENTED = 'Sunrise42-blue'; // gitleaks:allow (made up for the tests)
const WRONG = 'Sunrise42-grey';

const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

describe('session token codec', () => {
  const codec = createNodeTokenCodec();

  it('makes tokens of 256 random bits behind a prefix that names their kind', () => {
    const access = codec.generate('access');
    const refresh = codec.generate('refresh');
    expect(access).toMatch(/^hka_[A-Za-z0-9_-]{43}$/);
    expect(refresh).toMatch(/^hkr_[A-Za-z0-9_-]{43}$/);
    expect(TOKEN_PREFIXES).toEqual({ access: 'hka_', refresh: 'hkr_' });
    // 43 base64url characters carry exactly 32 bytes.
    expect(Buffer.from(access.slice(4), 'base64url')).toHaveLength(32);
  });

  it('never makes the same token twice', () => {
    const tokens = Array.from({ length: 5000 }, (_, index) =>
      codec.generate(index % 2 === 0 ? 'access' : 'refresh'),
    );
    expect(new Set(tokens).size).toBe(5000);
  });

  it('stores a token as its SHA-256', () => {
    // The published vector for "abc" (FIPS 180-2).
    expect(codec.hash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const token = codec.generate('refresh');
    expect(codec.hash(token)).toBe(
      createHash('sha256').update(token, 'utf8').digest('hex'),
    );
    expect(codec.hash(token)).not.toContain(token.slice(4));
  });
});

describe('Argon2id needsRehash', () => {
  const current = createArgon2idPasswordHasher({
    memoryKiB: 64,
    passes: 2,
    parallelism: 1,
  });
  const made = (memoryKiB: number, passes: number, parallelism: number) =>
    createArgon2idPasswordHasher({ memoryKiB, passes, parallelism }).hash(
      INVENTED,
    );

  it('leaves a hash made with today’s settings, or stronger, alone', async () => {
    expect(current.needsRehash(await current.hash(INVENTED))).toBe(false);
    expect(current.needsRehash(await made(128, 2, 1))).toBe(false);
    expect(current.needsRehash(await made(64, 3, 1))).toBe(false);
  });

  it('asks for a rehash when memory or passes are below today’s', async () => {
    expect(current.needsRehash(await made(32, 2, 1))).toBe(true);
    expect(current.needsRehash(await made(64, 1, 1))).toBe(true);
  });

  it('asks for a rehash when the lanes differ', async () => {
    expect(current.needsRehash(await made(64, 2, 2))).toBe(true);
  });

  it.each(['', 'not a hash', 'test-hash:x', '$2b$10$abcdefghijklmnopqrstuv'])(
    'asks for a rehash of %j, which it cannot read',
    (hash) => {
      expect(current.needsRehash(hash)).toBe(true);
    },
  );
});

describeWithPostgres('sessions on PostgreSQL', () => {
  let schema: TestSchema<IdentityTables>;
  let database: Database;
  let users: PgUserRepository;
  let sessionRepository: PgSessionRepository;
  let attemptsRepository: PgPasswordAttemptsRepository;

  const within = <T>(action: () => Promise<T>): Promise<T> =>
    withSystemTransaction(database, action);

  const table = (name: string) => sql.raw(`${schema.name}.${name}`);

  const query = <Row extends Record<string, unknown>>(
    statement: ReturnType<typeof sql>,
  ): Promise<Row[]> =>
    within(async () => {
      const result = await requireSystemTransaction().execute<Row>(statement);
      return result.rows as unknown as Row[];
    });

  const errorOf = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action();
    } catch (error) {
      if (isDomainError(error)) return error.code;
      const cause = (error as { cause?: { message?: string } }).cause;
      return cause?.message ?? (error as Error).message;
    }
    return 'nothing was thrown';
  };

  const ensureUser = async (userId: string): Promise<void> => {
    await query(sql`
      insert into ${table('users')} (id, name, locale, status, created_at)
      values (${userId}, 'Ada Example', 'en', 'active', now())
      on conflict (id) do nothing`);
  };

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'sessions',
      define: (pgSchema) => identityTables(pgSchema),
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'sessions-spec',
      maxConnections: 12,
    });
    users = new PgUserRepository(schema.tables);
    sessionRepository = new PgSessionRepository(schema.tables);
    attemptsRepository = new PgPasswordAttemptsRepository(schema.tables);
  });

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await query(sql`delete from ${table('otp_challenges')}`);
    // Identifiers, sessions, token pairs and attempt counts go with their users.
    await query(sql`delete from ${table('users')}`);
  });

  describe('PgSessionRepository conformance', () => {
    for (const testCase of sessionRepositoryConformance) {
      it(testCase.name, () =>
        testCase.run({ sessions: sessionRepository, within, ensureUser }),
      );
    }
  });

  describe('PgPasswordAttemptsRepository conformance', () => {
    for (const testCase of passwordAttemptsConformance) {
      it(testCase.name, () =>
        testCase.run({
          passwordAttempts: attemptsRepository,
          within,
          ensureUser,
        }),
      );
    }
  });

  describe('the tables', () => {
    const USER = '018f0000-0000-7000-8000-0000000000b1';
    const SESSION = '018f0000-0000-7000-8000-0000000000b2';

    const insertSession = (
      id: string,
      columns: {
        method?: string;
        revokedAt?: string | null;
        reason?: string | null;
      } = {},
    ) =>
      query(sql`
        insert into ${table('sessions')}
          (id, user_id, method, created_at, last_used_at, revoked_at, revoke_reason)
        values (${id}, ${USER}, ${columns.method ?? 'password'}, now(), now(),
                ${columns.revokedAt ?? null}::timestamptz, ${columns.reason ?? null})`);

    const insertPair = (id: string, access: string, refresh: string) =>
      query(sql`
        insert into ${table('session_token_pairs')}
          (id, session_id, access_hash, refresh_hash, issued_at,
           access_expires_at, refresh_expires_at)
        values (${id}, ${SESSION}, ${access}, ${refresh}, now(), now(), now())`);

    const pairId = (n: number) => `018f0000-0000-7000-8000-00000000c00${n}`;

    it.each<[string, string, () => Promise<unknown>]>([
      [
        'a session with an unknown method',
        'sessions_method',
        () => insertSession(SESSION, { method: 'magic' }),
      ],
      [
        'a session with an unknown reason for ending',
        'sessions_revoke_reason',
        () =>
          insertSession(SESSION, {
            revokedAt: '2026-11-28T09:00:00Z',
            reason: 'bored',
          }),
      ],
      [
        'a session ended without a reason',
        'sessions_revoked_with_reason',
        () => insertSession(SESSION, { revokedAt: '2026-11-28T09:00:00Z' }),
      ],
      [
        'a reason on a session that has not ended',
        'sessions_revoked_with_reason',
        () => insertSession(SESSION, { reason: 'signed_out' }),
      ],
      [
        'two pairs with the same access hash',
        'session_token_pairs_access_uq',
        async () => {
          await insertSession(SESSION);
          await insertPair(pairId(1), 'same-access', 'refresh-1');
          await insertPair(pairId(2), 'same-access', 'refresh-2');
        },
      ],
      [
        'two pairs with the same refresh hash',
        'session_token_pairs_refresh_uq',
        async () => {
          await insertSession(SESSION);
          await insertPair(pairId(1), 'access-1', 'same-refresh');
          await insertPair(pairId(2), 'access-2', 'same-refresh');
        },
      ],
      [
        'a pair whose two hashes are the same',
        'session_token_pairs_distinct_hashes',
        async () => {
          await insertSession(SESSION);
          await insertPair(pairId(1), 'one-hash', 'one-hash');
        },
      ],
      [
        'a pair with no session',
        'session_token_pairs_session_id',
        () => insertPair(pairId(1), 'access-1', 'refresh-1'),
      ],
      [
        'a negative attempt count',
        'password_attempts_count',
        () =>
          query(sql`
            insert into ${table('password_attempts')} (user_id, count)
            values (${USER}, -1)`),
      ],
    ])('refuse %s', async (_name, constraint, insert) => {
      await ensureUser(USER);
      expect(await errorOf(insert)).toContain(constraint);
    });

    it('refuse a session or an attempt count for a user that does not exist', async () => {
      expect(await errorOf(() => insertSession(SESSION))).toContain(
        'sessions_user_id',
      );
      expect(
        await errorOf(() =>
          query(sql`
            insert into ${table('password_attempts')} (user_id, count)
            values (${USER}, 1)`),
        ),
      ).toContain('password_attempts_user_id');
    });

    it('remove a user’s sessions, pairs and count with the user', async () => {
      await ensureUser(USER);
      await insertSession(SESSION);
      await insertPair(pairId(1), 'access-1', 'refresh-1');
      await query(sql`
        insert into ${table('password_attempts')} (user_id, count)
        values (${USER}, 3)`);
      await query(sql`delete from ${table('users')} where id = ${USER}`);
      const left = await query<{ n: number }>(sql`
        select (select count(*) from ${table('sessions')})
             + (select count(*) from ${table('session_token_pairs')})
             + (select count(*) from ${table('password_attempts')}) as n`);
      expect(Number(left[0]?.n)).toBe(0);
    });
  });

  describe('the session use cases, on the real database', () => {
    const PHONE = '+237600000001';
    let clock: FixedClock;
    let otpCodec: ReturnType<typeof createTestOtpCodec>;
    let accounts: Accounts;
    let sessions: Sessions;
    let userId: string;

    const lastCode = (): string =>
      otpCodec.issued[otpCodec.issued.length - 1] as string;
    const wait = (seconds: number): void => clock.advance(seconds * 1000);

    const signIn = (password = INVENTED): Promise<SessionTokens> =>
      sessions.signInWithPassword({
        identifier: PHONE,
        password,
        deviceName: 'Till 2',
      });

    const isLive = async (accessToken: string): Promise<boolean> =>
      (await errorOf(() => sessions.authenticate({ accessToken }))) ===
      'nothing was thrown';

    const sessionRow = async (sessionId: string) =>
      (
        await query<{ revoked_at: unknown; revoke_reason: string | null }>(
          sql`select revoked_at, revoke_reason from ${table('sessions')}
              where id = ${sessionId}`,
        )
      )[0];

    const livePairs = async (sessionId: string): Promise<number> =>
      Number(
        (
          await query<{ n: number }>(
            sql`select count(*)::int as n from ${table('session_token_pairs')}
                where session_id = ${sessionId} and rotated_at is null`,
          )
        )[0]?.n,
      );

    beforeEach(async () => {
      clock = new FixedClock('2026-11-28T09:00:00.000Z');
      otpCodec = createTestOtpCodec();
      const shared = {
        users,
        otps: new PgOtpRepository(schema.tables),
        sessions: sessionRepository,
        passwordAttempts: attemptsRepository,
        unitOfWork: createPgIdentityUnitOfWork(database),
        passwordHasher: insecureTestPasswordHasher,
        otpCodec,
        messenger: createMessenger({
          sms: createFakeSmsSender(clock),
          whatsapp: createFakeWhatsAppSender(clock),
          email: createFakeEmailSender(clock),
        }),
        clock,
        newId: createUuidV7Generator(),
        appName: 'HK',
      };
      accounts = createAccounts(shared);
      sessions = createSessions({
        ...shared,
        tokenCodec: createNodeTokenCodec(),
      });
      ({ userId } = await accounts.signUp({
        name: 'Ada Example',
        phone: PHONE,
        password: INVENTED,
      }));
      await accounts.verifyCode({ identifier: PHONE, code: lastCode() });
    });

    it('signs in, authenticates, refreshes and signs out', async () => {
      const first = await signIn();
      expect(first.accessToken).toMatch(/^hka_/);
      expect(first.refreshToken).toMatch(/^hkr_/);
      expect(
        await sessions.authenticate({ accessToken: first.accessToken }),
      ).toEqual({
        userId,
        sessionId: first.sessionId,
        method: 'password',
        signedInAt: '2026-11-28T09:00:00.000Z',
        accessExpiresAt: '2026-11-28T09:15:00.000Z',
      });

      wait(600);
      const second = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      expect(await isLive(first.accessToken)).toBe(false);
      expect(await isLive(second.accessToken)).toBe(true);
      expect(await sessions.listSessions({ userId })).toEqual([
        {
          id: first.sessionId,
          method: 'password',
          deviceName: 'Till 2',
          createdAt: '2026-11-28T09:00:00.000Z',
          lastUsedAt: '2026-11-28T09:10:00.000Z',
          current: false,
        },
      ]);

      await sessions.signOut({ userId, sessionId: first.sessionId });
      expect(await isLive(second.accessToken)).toBe(false);
      expect(await sessions.listSessions({ userId })).toEqual([]);
    });

    it('keeps no token in the database, only hashes', async () => {
      const tokens = await signIn();
      const rows = await query(
        sql`select * from ${table('session_token_pairs')}`,
      );
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain(tokens.accessToken);
      expect(stored).not.toContain(tokens.accessToken.slice(4));
      expect(stored).not.toContain(tokens.refreshToken.slice(4));
      expect(rows[0]).toMatchObject({
        access_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        refresh_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    });

    it('ends the session on reuse, although the request that found it fails', async () => {
      const first = await signIn();
      const second = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      wait(31);
      expect(
        await errorOf(() =>
          sessions.refresh({ refreshToken: first.refreshToken }),
        ),
      ).toBe(IDENTITY_ERRORS.SESSION_INVALID);
      expect(await sessionRow(first.sessionId)).toMatchObject({
        revoke_reason: 'reuse_detected',
      });
      expect(await isLive(second.accessToken)).toBe(false);
    });

    it('leaves exactly one usable pair when one refresh token is sent five times at once', async () => {
      const first = await signIn();
      const results = await Promise.all(
        Array.from({ length: 5 }, async () => {
          try {
            return await sessions.refresh({ refreshToken: first.refreshToken });
          } catch {
            return null;
          }
        }),
      );
      // Inside the retry window each request is a retry of the one before:
      // it kills that one's pair and gets its own. Never two live pairs.
      expect(await livePairs(first.sessionId)).toBe(1);
      const live = await Promise.all(
        results.map((tokens) =>
          tokens ? isLive(tokens.accessToken) : Promise.resolve(false),
        ),
      );
      expect(live.filter(Boolean)).toHaveLength(1);
      expect((await sessionRow(first.sessionId))?.revoked_at).toBeNull();
    });

    it('ends the session when a used refresh token is sent twice at once, later', async () => {
      const first = await signIn();
      const second = await sessions.refresh({
        refreshToken: first.refreshToken,
      });
      wait(31);
      const outcomes = await Promise.all([
        errorOf(() => sessions.refresh({ refreshToken: first.refreshToken })),
        errorOf(() => sessions.refresh({ refreshToken: first.refreshToken })),
      ]);
      expect(outcomes).toEqual([
        IDENTITY_ERRORS.SESSION_INVALID,
        IDENTITY_ERRORS.SESSION_INVALID,
      ]);
      expect(await isLive(second.accessToken)).toBe(false);
    });

    it('holds the ten-attempt limit when thirty wrong passwords arrive at once', async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 30 }, () => errorOf(() => signIn(WRONG))),
      );
      const tally = (wanted: string) =>
        outcomes.filter((outcome) => outcome === wanted).length;
      expect(tally(IDENTITY_ERRORS.CREDENTIALS_INVALID)).toBe(10);
      expect(tally(IDENTITY_ERRORS.ACCOUNT_LOCKED)).toBe(20);
      const stored = await query<{ count: number; locked_until: unknown }>(
        sql`select count, locked_until from ${table('password_attempts')}`,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.count).toBe(10);
      expect(new Date(String(stored[0]?.locked_until)).toISOString()).toBe(
        '2026-11-28T10:00:00.000Z',
      );
      // The right password is refused too, until the hour is up.
      expect(await errorOf(() => signIn())).toBe(
        IDENTITY_ERRORS.ACCOUNT_LOCKED,
      );
      wait(3600);
      expect((await signIn()).userId).toBe(userId);
      expect(
        await query(sql`select 1 from ${table('password_attempts')}`),
      ).toEqual([]);
    });

    it('ends every session in the same transaction as a password reset', async () => {
      const a = await signIn();
      const b = await signIn();
      await accounts.requestPasswordReset({ identifier: PHONE });
      await accounts.resetPassword({
        identifier: PHONE,
        code: lastCode(),
        newPassword: 'Brand-new-Pass9',
      });
      expect(await isLive(a.accessToken)).toBe(false);
      expect(await isLive(b.accessToken)).toBe(false);
      expect(await errorOf(() => signIn())).toBe(
        IDENTITY_ERRORS.CREDENTIALS_INVALID,
      );
      expect((await signIn('Brand-new-Pass9')).userId).toBe(userId);
    });

    it('signs in with a code, once, even when two requests carry it at once', async () => {
      await sessions.requestSignInCode({ identifier: PHONE });
      const code = lastCode();
      const outcomes = await Promise.all([
        errorOf(() => sessions.signInWithCode({ identifier: PHONE, code })),
        errorOf(() => sessions.signInWithCode({ identifier: PHONE, code })),
      ]);
      expect(outcomes.sort()).toEqual(
        [IDENTITY_ERRORS.OTP_EXPIRED, 'nothing was thrown'].sort(),
      );
      const started = await query<{ method: string }>(
        sql`select method from ${table('sessions')}`,
      );
      expect(started).toEqual([{ method: 'otp' }]);
    });

    it('replaces a weak password hash at sign-in, with real Argon2id', async () => {
      const weak = createArgon2idPasswordHasher({
        memoryKiB: 32,
        passes: 1,
        parallelism: 1,
      });
      const strong = createArgon2idPasswordHasher({
        memoryKiB: 64,
        passes: 2,
        parallelism: 1,
      });
      await within(async () =>
        users.setPasswordHash(
          userId,
          await weak.hash(INVENTED),
          clock.now().toISOString(),
        ),
      );
      const real = createSessions({
        users,
        otps: new PgOtpRepository(schema.tables),
        sessions: sessionRepository,
        passwordAttempts: attemptsRepository,
        unitOfWork: createPgIdentityUnitOfWork(database),
        passwordHasher: strong,
        otpCodec,
        tokenCodec: createNodeTokenCodec(),
        messenger: createMessenger({
          sms: createFakeSmsSender(clock),
          whatsapp: createFakeWhatsAppSender(clock),
          email: createFakeEmailSender(clock),
        }),
        clock,
        newId: createUuidV7Generator(),
        appName: 'HK',
      });
      await real.signInWithPassword({ identifier: PHONE, password: INVENTED });
      const stored = await within(() => users.passwordHashOf(userId));
      expect(stored).toContain('m=64,t=2,p=1');
      expect(await strong.verify(INVENTED, stored as string)).toBe(true);
    });
  });
});
