import {
  FakePasskeyDevice,
  createFakePasskeyVerifier,
  createPasskeys,
  createTestTokenCodec,
  passkeyChallengeConformance,
  passkeyRepositoryConformance,
  type Passkeys,
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
  PgPasskeyChallengeRepository,
  PgPasskeyRepository,
  PgSessionRepository,
  PgUserRepository,
  createPgIdentityUnitOfWork,
} from './pg-repositories';
import { identityTables, type IdentityTables } from './schema';

// Every phone number and credential in this file is invented.

const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

describe('test setup', () => {
  it('has a PostgreSQL to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
    }
  });
});

describeWithPostgres('passkeys on PostgreSQL', () => {
  let schema: TestSchema<IdentityTables>;
  let database: Database;
  let passkeyRepository: PgPasskeyRepository;
  let challengeRepository: PgPasskeyChallengeRepository;

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
      prefix: 'passkeys',
      define: (pgSchema) => identityTables(pgSchema),
    });
    database = createDatabase({
      url: schema.appUrl,
      name: 'passkeys-spec',
      maxConnections: 12,
    });
    passkeyRepository = new PgPasskeyRepository(schema.tables);
    challengeRepository = new PgPasskeyChallengeRepository(schema.tables);
  });

  afterAll(async () => {
    await database?.close();
    await schema?.drop();
  });

  beforeEach(async () => {
    await query(sql`delete from ${table('passkey_challenges')}`);
    // Passkeys and sessions go with their users.
    await query(sql`delete from ${table('users')}`);
  });

  describe('PgPasskeyRepository conformance', () => {
    for (const testCase of passkeyRepositoryConformance) {
      it(testCase.name, () =>
        testCase.run({ passkeys: passkeyRepository, within, ensureUser }),
      );
    }
  });

  describe('PgPasskeyChallengeRepository conformance', () => {
    for (const testCase of passkeyChallengeConformance) {
      it(testCase.name, () =>
        testCase.run({ passkeyChallenges: challengeRepository, within }),
      );
    }
  });

  describe('the tables', () => {
    const USER = '018f0000-0000-7000-8000-0000000000d1';
    const id = (n: number) => `018f0000-0000-7000-8000-00000000d00${n}`;

    const insertPasskey = (n: number, credentialId: string, signCount = 0) =>
      query(sql`
        insert into ${table('passkeys')}
          (id, user_id, credential_id, public_key, sign_count, transports,
           multi_device, backed_up, name, created_at)
        values (${id(n)}, ${USER}, ${credentialId}, 'cHVibGlj', ${signCount},
                '{}', true, true, 'Key', now())`);

    const insertChallenge = (ceremony: string, userId: string | null) =>
      query(sql`
        insert into ${table('passkey_challenges')}
          (id, ceremony, user_id, challenge, created_at, expires_at)
        values (${id(9)}, ${ceremony}, ${userId}, 'Y2hhbGxlbmdl', now(), now())`);

    it.each<[string, string, () => Promise<unknown>]>([
      [
        'one credential registered twice',
        'passkeys_credential_uq',
        async () => {
          await insertPasskey(1, 'same-credential');
          await insertPasskey(2, 'same-credential');
        },
      ],
      [
        'a negative use count',
        'passkeys_sign_count',
        () => insertPasskey(1, 'credential-1', -1),
      ],
      [
        'a challenge for an unknown ceremony',
        'passkey_challenges_ceremony',
        () => insertChallenge('conjuring', null),
      ],
      [
        'a registration challenge with no user',
        'passkey_challenges_user',
        () => insertChallenge('registration', null),
      ],
      [
        'a sign-in challenge tied to a user',
        'passkey_challenges_user',
        () => insertChallenge('authentication', USER),
      ],
    ])('refuse %s', async (_name, constraint, insert) => {
      await ensureUser(USER);
      expect(await errorOf(insert)).toContain(constraint);
    });

    it('refuse a passkey for a user that does not exist', async () => {
      expect(await errorOf(() => insertPasskey(1, 'credential-1'))).toContain(
        'passkeys_user_id',
      );
    });

    it('hold a use count larger than a 32-bit signed integer', async () => {
      await ensureUser(USER);
      // The largest count a device can report: 2^32 - 1.
      await insertPasskey(1, 'credential-1', 4_294_967_295);
      const found = await within(() =>
        passkeyRepository.findByCredentialId('credential-1'),
      );
      expect(found?.signCount).toBe(4_294_967_295);
    });

    it('remove a user’s passkeys with the user', async () => {
      await ensureUser(USER);
      await insertPasskey(1, 'credential-1');
      await query(sql`delete from ${table('users')} where id = ${USER}`);
      expect(await query(sql`select 1 from ${table('passkeys')}`)).toEqual([]);
    });
  });

  describe('the passkey use cases, on the real database', () => {
    const PHONE = { kind: 'phone', value: '+237600000001' } as const;
    let clock: FixedClock;
    let passkeys: Passkeys;
    let userId: string;
    let device: FakePasskeyDevice;

    beforeEach(async () => {
      clock = new FixedClock('2026-11-28T09:00:00.000Z');
      const users = new PgUserRepository(schema.tables);
      const newId = createUuidV7Generator();
      passkeys = createPasskeys({
        users,
        sessions: new PgSessionRepository(schema.tables),
        passkeys: passkeyRepository,
        passkeyChallenges: challengeRepository,
        unitOfWork: createPgIdentityUnitOfWork(database),
        verifier: createFakePasskeyVerifier(),
        tokenCodec: createTestTokenCodec(),
        clock,
        newId,
      });
      userId = newId();
      await within(async () => {
        await users.create({
          id: userId,
          name: 'Ada Example',
          locale: 'en',
          identifiers: [PHONE],
          passwordHash: null,
          createdAt: clock.now().toISOString(),
        });
        await users.markIdentifierVerified(
          userId,
          PHONE,
          clock.now().toISOString(),
        );
      });
      device = new FakePasskeyDevice('credential-phone');
      const start = await passkeys.beginRegistration({ userId });
      await passkeys.finishRegistration({
        userId,
        challengeId: start.challengeId,
        response: device.register(start.options),
        name: 'My phone',
      });
    });

    it('registers, signs in, renames and removes', async () => {
      const start = await passkeys.beginSignIn();
      const tokens = await passkeys.finishSignIn({
        challengeId: start.challengeId,
        response: device.authenticate(start.options),
      });
      expect(tokens.userId).toBe(userId);
      const sessions = await query<{ method: string }>(
        sql`select method from ${table('sessions')}`,
      );
      expect(sessions).toEqual([{ method: 'passkey' }]);

      const [listed] = await passkeys.listPasskeys({ userId });
      expect(listed).toMatchObject({
        name: 'My phone',
        lastUsedAt: '2026-11-28T09:00:00.000Z',
      });
      await passkeys.renamePasskey({
        userId,
        passkeyId: listed?.id as string,
        name: 'Old phone',
      });
      expect((await passkeys.listPasskeys({ userId }))[0]?.name).toBe(
        'Old phone',
      );
      await passkeys.removePasskey({ userId, passkeyId: listed?.id as string });
      expect(await passkeys.listPasskeys({ userId })).toEqual([]);
      // No challenge is left behind by any of it.
      expect(
        await query(sql`select 1 from ${table('passkey_challenges')}`),
      ).toEqual([]);
    });

    it('accepts one response once when it is sent five times at once', async () => {
      const start = await passkeys.beginSignIn();
      const response = device.authenticate(start.options);
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () =>
          errorOf(() =>
            passkeys.finishSignIn({ challengeId: start.challengeId, response }),
          ),
        ),
      );
      expect(
        outcomes.filter((outcome) => outcome === 'nothing was thrown'),
      ).toHaveLength(1);
      expect(
        outcomes.filter(
          (outcome) => outcome === IDENTITY_ERRORS.PASSKEY_INVALID,
        ),
      ).toHaveLength(4);
      const sessions = await query(sql`select 1 from ${table('sessions')}`);
      expect(sessions).toHaveLength(1);
    });

    it('lets one use count through when two responses carry the same count at once', async () => {
      // A counting device and a copy of it, both at count 1, each answering
      // its own challenge at the same moment.
      device.counts = true;
      const copy = new FakePasskeyDevice('credential-phone');
      copy.counts = true;
      copy.userId = userId;
      const [a, b] = await Promise.all([
        passkeys.beginSignIn(),
        passkeys.beginSignIn(),
      ]);
      const outcomes = await Promise.all([
        errorOf(() =>
          passkeys.finishSignIn({
            challengeId: a.challengeId,
            response: device.authenticate(a.options),
          }),
        ),
        errorOf(() =>
          passkeys.finishSignIn({
            challengeId: b.challengeId,
            response: copy.authenticate(b.options),
          }),
        ),
      ]);
      expect(outcomes.sort()).toEqual(
        [IDENTITY_ERRORS.PASSKEY_INVALID, 'nothing was thrown'].sort(),
      );
      const stored = await query<{ sign_count: string }>(
        sql`select sign_count from ${table('passkeys')}`,
      );
      expect(Number(stored[0]?.sign_count)).toBe(1);
    });

    it('registers one credential once when two accounts try at the same moment', async () => {
      const users = new PgUserRepository(schema.tables);
      const other = createUuidV7Generator()();
      const otherPhone = { kind: 'phone', value: '+237600000002' } as const;
      await within(async () => {
        await users.create({
          id: other,
          name: 'Ben Example',
          locale: 'en',
          identifiers: [otherPhone],
          passwordHash: null,
          createdAt: clock.now().toISOString(),
        });
        await users.markIdentifierVerified(
          other,
          otherPhone,
          clock.now().toISOString(),
        );
      });
      const shared = new FakePasskeyDevice('credential-shared');
      const [a, b] = await Promise.all([
        passkeys.beginRegistration({ userId }),
        passkeys.beginRegistration({ userId: other }),
      ]);
      const outcomes = await Promise.all([
        errorOf(() =>
          passkeys.finishRegistration({
            userId,
            challengeId: a.challengeId,
            response: shared.register(a.options),
          }),
        ),
        errorOf(() =>
          passkeys.finishRegistration({
            userId: other,
            challengeId: b.challengeId,
            response: shared.register(b.options),
          }),
        ),
      ]);
      expect(outcomes.sort()).toEqual(
        [
          IDENTITY_ERRORS.PASSKEY_ALREADY_REGISTERED,
          'nothing was thrown',
        ].sort(),
      );
    });
  });
});
