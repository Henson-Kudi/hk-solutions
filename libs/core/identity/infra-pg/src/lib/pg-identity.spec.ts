import { argon2Sync, createHmac } from 'node:crypto';
import {
  createFakeEmailSender,
  createFakeSmsSender,
  createFakeWhatsAppSender,
  createMessenger,
} from '@hk/core/comms/application';
import {
  createAccounts,
  createTestOtpCodec,
  insecureTestPasswordHasher,
  otpRepositoryConformance,
  userRepositoryConformance,
  type Accounts,
} from '@hk/core/identity/application';
import { IDENTITY_ERRORS, isOtpCode } from '@hk/core/identity/domain';
import {
  createDatabase,
  findTenantCatalogViolations,
  findTenantSchemaViolations,
  requireSystemTransaction,
  tablesOf,
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
  ARGON2ID_DEFAULTS,
  createArgon2idPasswordHasher,
  createHmacOtpCodec,
} from './node-crypto';
import {
  PgOtpRepository,
  PgPasswordAttemptsRepository,
  PgSessionRepository,
  PgUserRepository,
  createPgIdentityUnitOfWork,
} from './pg-repositories';
import {
  IDENTITY_GLOBAL_TABLES,
  identityTables,
  type IdentityTables,
} from './schema';

// Every phone number, address, password and secret in this file is invented.
const INVENTED = 'Sunrise42-blue'; // gitleaks:allow (made up for the tests)

/**
 * The repository tests need a real PostgreSQL (HK_TEST_DATABASE_URL;
 * `pnpm infra:up` locally). CI always has one.
 */
const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

describe('test setup', () => {
  it('has a PostgreSQL to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
    }
  });
});

describe('Argon2id password hasher', () => {
  // Small parameters keep most of these tests quick. One test uses the real ones.
  const quick = { memoryKiB: 64, passes: 1, parallelism: 1 };
  const hasher = createArgon2idPasswordHasher(quick);

  it('Node’s Argon2id matches the RFC 9106 test vector', () => {
    // RFC 9106 section 5.3.
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      memory: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    });
    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });

  it('uses OWASP’s recommended minimum by default, and writes it into the hash', async () => {
    expect(ARGON2ID_DEFAULTS).toEqual({
      memoryKiB: 19_456,
      passes: 2,
      parallelism: 1,
    });
    const real = createArgon2idPasswordHasher();
    const hash = await real.hash('Sunrise42-blue');
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(await real.verify('Sunrise42-blue', hash)).toBe(true);
    expect(await real.verify('Sunrise42-blup', hash)).toBe(false);
  });

  it('writes a hash another Argon2 implementation would compute the same', async () => {
    const hash = await hasher.hash('Sunrise42-blue');
    const [, , , , salt, tag] = hash.split('$');
    const independent = argon2Sync('argon2id', {
      message: Buffer.from('Sunrise42-blue', 'utf8'),
      nonce: Buffer.from(salt as string, 'base64'),
      memory: 64,
      passes: 1,
      parallelism: 1,
      tagLength: 32,
    });
    expect(independent.toString('base64').replace(/=+$/, '')).toBe(tag);
  });

  it('gives the same password a different hash each time', async () => {
    const a = await hasher.hash('Sunrise42-blue');
    const b = await hasher.hash('Sunrise42-blue');
    expect(a).not.toBe(b);
    expect(await hasher.verify('Sunrise42-blue', a)).toBe(true);
    expect(await hasher.verify('Sunrise42-blue', b)).toBe(true);
  });

  it('never contains the password', async () => {
    expect(await hasher.hash('Sunrise42-blue')).not.toContain('Sunrise');
  });

  it('is exact about case, spaces and length', async () => {
    const hash = await hasher.hash('Sunrise42-blue');
    for (const wrong of [
      'sunrise42-blue',
      'Sunrise42-blue ',
      ' Sunrise42-blue',
      'Sunrise42-blu',
      '',
    ]) {
      expect(await hasher.verify(wrong, hash)).toBe(false);
    }
  });

  it('treats two ways of typing the same letter as one password', async () => {
    // "é" as one character, and as "e" followed by a combining accent.
    const hash = await hasher.hash('Café-Soleil-42');
    expect(await hasher.verify('Café-Soleil-42', hash)).toBe(true);
  });

  it('still verifies a hash made with older, different parameters', async () => {
    const old = await createArgon2idPasswordHasher({
      memoryKiB: 32,
      passes: 2,
      parallelism: 2,
    }).hash('Sunrise42-blue');
    expect(old).toContain('m=32,t=2,p=2');
    expect(await hasher.verify('Sunrise42-blue', old)).toBe(true);
    expect(await hasher.verify('wrong', old)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['not a hash', 'password'],
    ['the test hasher’s form', 'test-hash:Sunrise42-blue'],
    [
      'another algorithm',
      '$argon2i$v=19$m=64,t=1,p=1$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43),
    ],
    [
      'another version',
      '$argon2id$v=16$m=64,t=1,p=1$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43),
    ],
    [
      'a gigabyte of memory',
      '$argon2id$v=19$m=1048576,t=1,p=1$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43),
    ],
    [
      'a hundred passes',
      '$argon2id$v=19$m=64,t=100,p=1$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43),
    ],
    [
      'too little memory for its lanes',
      '$argon2id$v=19$m=8,t=1,p=4$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43),
    ],
    [
      'zero passes',
      '$argon2id$v=19$m=64,t=0,p=1$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43),
    ],
    [
      'a trailing line',
      '$argon2id$v=19$m=64,t=1,p=1$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43) + '\n',
    ],
  ])(
    'answers false, quickly and without throwing, for %s',
    async (_name, hash) => {
      const started = Date.now();
      expect(await hasher.verify('Sunrise42-blue', hash)).toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
    },
  );
});

describe('HMAC one-time code codec', () => {
  const secret = Buffer.alloc(32, 7);
  const codec = createHmacOtpCodec(secret);

  it('makes six-digit codes, leading zeros included, and not the same one', () => {
    const codes = Array.from({ length: 2000 }, () => codec.generate());
    for (const code of codes) {
      expect(isOtpCode(code)).toBe(true);
    }
    // 2000 draws from a million: nearly all distinct, and some start with 0.
    expect(new Set(codes).size).toBeGreaterThan(1950);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
    // Each digit turns up about as often as the others.
    const counts = new Array<number>(10).fill(0);
    for (const digit of codes.join('')) {
      counts[Number(digit)] = (counts[Number(digit)] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(1000);
      expect(count).toBeLessThan(1400);
    }
  });

  it('is HMAC-SHA-256 of the binding and the code', () => {
    expect(codec.hash('123456', 'user|login|phone|+237600000001')).toBe(
      createHmac('sha256', secret)
        .update('30:user|login|phone|+237600000001:123456', 'utf8')
        .digest('hex'),
    );
  });

  it('gives a different hash for another code, binding or secret', () => {
    const base = codec.hash('123456', 'a|login');
    expect(codec.hash('123456', 'a|login')).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(codec.hash('123457', 'a|login')).not.toBe(base);
    expect(codec.hash('123456', 'a|password_reset')).not.toBe(base);
    expect(
      createHmacOtpCodec(Buffer.alloc(32, 8)).hash('123456', 'a|login'),
    ).not.toBe(base);
  });

  it('does not let a binding and a code run together', () => {
    expect(codec.hash('3456', 'a:12')).not.toBe(codec.hash('123456', 'a'));
    expect(codec.hash('456', 'a:123')).not.toBe(codec.hash('123:456', 'a'));
  });

  it('refuses a short secret', () => {
    expect(() => createHmacOtpCodec(Buffer.alloc(31, 1))).toThrow(
      /at least 32 bytes/,
    );
    expect(() => createHmacOtpCodec(new Uint8Array(0))).toThrow();
  });

  it('keeps its own copy of the secret', () => {
    const mutable = Buffer.alloc(32, 9);
    const own = createHmacOtpCodec(mutable);
    const before = own.hash('123456', 'a');
    mutable.fill(0);
    expect(own.hash('123456', 'a')).toBe(before);
  });
});

describeWithPostgres('identity on PostgreSQL', () => {
  let schema: TestSchema<IdentityTables>;
  let database: Database;
  let users: PgUserRepository;
  let otps: PgOtpRepository;

  const within = <T>(action: () => Promise<T>): Promise<T> =>
    withSystemTransaction(database, action);

  const table = (name: string) => sql.raw(`${schema.name}.${name}`);

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

  beforeAll(async () => {
    schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'identity',
      define: (pgSchema) => identityTables(pgSchema),
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'identity-spec',
      maxConnections: 12,
    });
    users = new PgUserRepository(schema.tables);
    otps = new PgOtpRepository(schema.tables);
  });

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await within(async () => {
      const transaction = requireSystemTransaction();
      await transaction.execute(sql`delete from ${table('otp_challenges')}`);
      // The identifiers go with their users.
      await transaction.execute(sql`delete from ${table('users')}`);
    });
  });

  describe('PgUserRepository conformance', () => {
    for (const testCase of userRepositoryConformance) {
      it(testCase.name, () => testCase.run({ users, within }));
    }
  });

  describe('PgOtpRepository conformance', () => {
    for (const testCase of otpRepositoryConformance) {
      it(testCase.name, () => testCase.run({ otps, within }));
    }
  });

  describe('the tables', () => {
    const exempt = () =>
      IDENTITY_GLOBAL_TABLES.map((name) => `${schema.name}.${name}`);

    it('are global: the tenancy check flags each one unless it is listed as exempt', async () => {
      const tables = tablesOf(schema.tables);
      expect(tables).toHaveLength(IDENTITY_GLOBAL_TABLES.length);
      const flagged = new Set(
        findTenantSchemaViolations(tables).map((violation) => violation.table),
      );
      expect([...flagged].sort()).toEqual(exempt().sort());
      expect(findTenantSchemaViolations(tables, { exempt: exempt() })).toEqual(
        [],
      );

      const inDatabase = await within(() =>
        findTenantCatalogViolations(requireSystemTransaction(), schema.name, {
          exempt: exempt(),
        }),
      );
      expect(inDatabase).toEqual([]);
    });

    it('cannot be reached from a tenant transaction’s repository path', async () => {
      // The repositories ask for a system transaction; outside one they refuse.
      expect(await errorOf(() => users.findById(crypto.randomUUID()))).toBe(
        'TRANSACTION_MISSING',
      );
    });

    const insertUser = (id: string, status = 'pending') =>
      requireSystemTransaction().execute(sql`
        insert into ${table('users')} (id, name, locale, status, created_at)
        values (${id}, 'Ada Example', 'en', ${status}, now())`);

    const USER_A = '018f0000-0000-7000-8000-0000000000a1';
    const USER_B = '018f0000-0000-7000-8000-0000000000a2';

    it('lets one phone number belong to one user only', async () => {
      const message = await errorOf(() =>
        within(async () => {
          await insertUser(USER_A);
          await insertUser(USER_B);
          await requireSystemTransaction().execute(sql`
            insert into ${table('user_identifiers')} (kind, value, user_id)
            values ('phone', '+237600000001', ${USER_A}),
                   ('phone', '+237600000001', ${USER_B})`);
        }),
      );
      expect(message).toMatch(/user_identifiers_pk/);
    });

    it('lets a user have one phone number only', async () => {
      const message = await errorOf(() =>
        within(async () => {
          await insertUser(USER_A);
          await requireSystemTransaction().execute(sql`
            insert into ${table('user_identifiers')} (kind, value, user_id)
            values ('phone', '+237600000001', ${USER_A}),
                   ('phone', '+237600000002', ${USER_A})`);
        }),
      );
      expect(message).toMatch(/user_identifiers_user_kind_uq/);
    });

    it.each([
      [
        'an unknown status',
        'users_status',
        (id: string) => insertUser(id, 'banned'),
      ],
      [
        'an unknown kind of identifier',
        'user_identifiers_kind',
        async (id: string) => {
          await insertUser(id);
          await requireSystemTransaction().execute(sql`
            insert into ${table('user_identifiers')} (kind, value, user_id)
            values ('fax', '+237600000001', ${id})`);
        },
      ],
      [
        'an identifier with no user',
        'user_identifiers_user_id',
        (id: string) =>
          requireSystemTransaction().execute(sql`
            insert into ${table('user_identifiers')} (kind, value, user_id)
            values ('phone', '+237600000001', ${id})`),
      ],
      [
        'a code with an unknown purpose',
        'otp_challenges_purpose',
        (id: string) =>
          requireSystemTransaction().execute(sql`
            insert into ${table('otp_challenges')}
              (id, user_id, identifier_kind, identifier_value, purpose,
               channel, code_hash, created_at, expires_at)
            values (${id}, ${id}, 'phone', '+237600000001', 'anything',
                    'sms', 'x', now(), now())`),
      ],
      [
        'a code with an unknown channel',
        'otp_challenges_channel',
        (id: string) =>
          requireSystemTransaction().execute(sql`
            insert into ${table('otp_challenges')}
              (id, user_id, identifier_kind, identifier_value, purpose,
               channel, code_hash, created_at, expires_at)
            values (${id}, ${id}, 'phone', '+237600000001', 'login',
                    'pigeon', 'x', now(), now())`),
      ],
      [
        'a negative attempt count',
        'otp_challenges_attempts',
        (id: string) =>
          requireSystemTransaction().execute(sql`
            insert into ${table('otp_challenges')}
              (id, user_id, identifier_kind, identifier_value, purpose,
               channel, code_hash, created_at, expires_at, attempts)
            values (${id}, ${id}, 'phone', '+237600000001', 'login',
                    'sms', 'x', now(), now(), -1)`),
      ],
    ])('refuses %s', async (_name, constraint, insert) => {
      const message = await errorOf(() =>
        within(async () => {
          await insert(USER_A);
        }),
      );
      expect(message).toContain(constraint);
    });

    it('removes a user’s identifiers with the user, and keeps its codes', async () => {
      const identifier = { kind: 'phone', value: '+237600000001' } as const;
      await within(async () => {
        await users.create({
          id: USER_A,
          name: 'Ada Example',
          locale: 'en',
          identifiers: [identifier],
          passwordHash: null,
          createdAt: '2026-11-28T09:00:00.000Z',
        });
        await otps.create({
          id: USER_B,
          userId: USER_A,
          identifier,
          purpose: 'verify_identifier',
          channel: 'sms',
          codeHash: 'x',
          createdAt: '2026-11-28T09:00:00.000Z',
          expiresAt: '2026-11-28T09:10:00.000Z',
          attempts: 0,
          consumedAt: null,
        });
        await users.discardPending(USER_A);
      });
      const counts = await within(async () => {
        const transaction = requireSystemTransaction();
        const identifiers = await transaction.execute<{ n: number }>(
          sql`select count(*)::int as n from ${table('user_identifiers')}`,
        );
        const codes = await transaction.execute<{ n: number }>(
          sql`select count(*)::int as n from ${table('otp_challenges')}`,
        );
        return [identifiers.rows[0]?.n, codes.rows[0]?.n];
      });
      // The code row stays so that the resend limit still counts it.
      expect(counts).toEqual([0, 1]);
    });
  });

  describe('the account use cases, on the real database', () => {
    const PHONE = '+237600000001';
    let clock: FixedClock;
    let codec: ReturnType<typeof createTestOtpCodec>;
    let accounts: Accounts;

    const lastCode = (): string =>
      codec.issued[codec.issued.length - 1] as string;
    const attemptsStored = async (): Promise<number[]> => {
      const result = await within(() =>
        requireSystemTransaction().execute<{ attempts: number }>(
          sql`select attempts from ${table('otp_challenges')} order by created_at`,
        ),
      );
      return result.rows.map((row) => row.attempts);
    };

    beforeEach(() => {
      clock = new FixedClock('2026-11-28T09:00:00.000Z');
      codec = createTestOtpCodec();
      accounts = createAccounts({
        users,
        otps,
        sessions: new PgSessionRepository(schema.tables),
        passwordAttempts: new PgPasswordAttemptsRepository(schema.tables),
        unitOfWork: createPgIdentityUnitOfWork(database),
        passwordHasher: insecureTestPasswordHasher,
        otpCodec: codec,
        messenger: createMessenger({
          sms: createFakeSmsSender(clock),
          whatsapp: createFakeWhatsAppSender(clock),
          email: createFakeEmailSender(clock),
        }),
        clock,
        newId: createUuidV7Generator(),
        appName: 'HK',
      });
    });

    const signUp = (phone = PHONE) =>
      accounts.signUp({
        name: 'Ada Example',
        phone,
        password: INVENTED,
        locale: 'fr',
      });

    it('signs up, verifies and activates', async () => {
      const { userId } = await signUp();
      const result = await accounts.verifyCode({
        identifier: PHONE,
        code: lastCode(),
      });
      expect(result).toEqual({ userId, complete: true, codeSent: null });
      const user = await within(() => users.findById(userId));
      expect(user).toMatchObject({
        status: 'active',
        locale: 'fr',
        hasPassword: true,
        identifiers: [
          {
            kind: 'phone',
            value: PHONE,
            verifiedAt: '2026-11-28T09:00:00.000Z',
          },
        ],
      });
    });

    it('keeps a wrong attempt although the request ends in an error', async () => {
      await signUp();
      expect(
        await errorOf(() =>
          accounts.verifyCode({ identifier: PHONE, code: '000000' }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_INVALID);
      expect(await attemptsStored()).toEqual([1]);
    });

    it('holds the five-attempt limit when ten guesses arrive at once', async () => {
      await signUp();
      const code = lastCode();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () =>
          errorOf(() =>
            accounts.verifyCode({ identifier: PHONE, code: '000000' }),
          ),
        ),
      );
      const tally = (wanted: string) =>
        outcomes.filter((outcome) => outcome === wanted).length;
      expect(tally(IDENTITY_ERRORS.OTP_INVALID)).toBe(4);
      expect(tally(IDENTITY_ERRORS.OTP_MAX_ATTEMPTS)).toBe(1);
      expect(tally(IDENTITY_ERRORS.OTP_EXPIRED)).toBe(5);
      expect(await attemptsStored()).toEqual([5]);
      // The right code no longer works either.
      expect(
        await errorOf(() => accounts.verifyCode({ identifier: PHONE, code })),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
    });

    it('accepts a code once when it is submitted twice at the same moment', async () => {
      await signUp();
      const code = lastCode();
      const outcomes = await Promise.all([
        errorOf(() => accounts.verifyCode({ identifier: PHONE, code })),
        errorOf(() => accounts.verifyCode({ identifier: PHONE, code })),
      ]);
      expect(outcomes.sort()).toEqual(
        [IDENTITY_ERRORS.OTP_EXPIRED, 'nothing was thrown'].sort(),
      );
    });

    it('gives a phone number to one of two sign-ups that arrive at once', async () => {
      const outcomes = await Promise.all([
        errorOf(() => signUp()),
        errorOf(() => signUp()),
      ]);
      // Either the second is told the number is taken, or it replaces the
      // first's abandoned sign-up. Never two accounts with one number.
      const holders = await within(() =>
        requireSystemTransaction().execute<{ n: number }>(
          sql`select count(*)::int as n from ${table('user_identifiers')}
              where value = ${PHONE}`,
        ),
      );
      expect(holders.rows[0]?.n).toBe(1);
      expect(outcomes).toContain('nothing was thrown');
    });

    it('rolls a failed sign-up back completely', async () => {
      await signUp();
      await accounts.verifyCode({ identifier: PHONE, code: lastCode() });
      clock.set(new Date('2026-11-28T09:05:00.000Z'));
      // A second person: new email, but the phone is taken. Nothing of the
      // attempt may remain.
      expect(
        await errorOf(() =>
          accounts.signUp({
            name: 'Someone Else',
            phone: PHONE,
            email: 'else@example.com',
          }),
        ),
      ).toBe(IDENTITY_ERRORS.IDENTIFIER_TAKEN);
      const rows = await within(() =>
        requireSystemTransaction().execute<{ n: number }>(
          sql`select count(*)::int as n from ${table('users')}`,
        ),
      );
      expect(rows.rows[0]?.n).toBe(1);
    });

    it('works with the real hasher and the real code maker', async () => {
      const sms = createFakeSmsSender(clock);
      const withSms = createAccounts({
        users,
        otps,
        sessions: new PgSessionRepository(schema.tables),
        passwordAttempts: new PgPasswordAttemptsRepository(schema.tables),
        unitOfWork: createPgIdentityUnitOfWork(database),
        passwordHasher: createArgon2idPasswordHasher(),
        otpCodec: createHmacOtpCodec(Buffer.alloc(32, 5)),
        messenger: createMessenger({
          sms,
          whatsapp: createFakeWhatsAppSender(clock),
          email: createFakeEmailSender(clock),
        }),
        clock,
        newId: createUuidV7Generator(),
        appName: 'HK',
      });
      const { userId } = await withSms.signUp({
        name: 'Ada Example',
        phone: PHONE,
        password: INVENTED,
      });
      const code = /\b(\d{6})\b/.exec(sms.last()?.text ?? '')?.[1] as string;
      await withSms.verifyCode({ identifier: PHONE, code });

      const stored = await within(() =>
        requireSystemTransaction().execute<{
          password_hash: string;
          code_hash: string;
        }>(
          sql`select u.password_hash, c.code_hash
              from ${table('users')} u, ${table('otp_challenges')} c
              where u.id = ${userId}`,
        ),
      );
      expect(stored.rows[0]?.password_hash).toMatch(
        /^\$argon2id\$v=19\$m=19456,/,
      );
      expect(stored.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored.rows)).not.toContain(code);
      expect(JSON.stringify(stored.rows)).not.toContain('Sunrise');

      await withSms.changePassword({
        userId,
        currentPassword: INVENTED,
        newPassword: 'Brand-new-Pass9',
      });
      expect(
        await errorOf(() =>
          withSms.changePassword({
            userId,
            currentPassword: INVENTED,
            newPassword: 'Another-Pass10',
          }),
        ),
      ).toBe(IDENTITY_ERRORS.CREDENTIALS_INVALID);
    });
  });
});
