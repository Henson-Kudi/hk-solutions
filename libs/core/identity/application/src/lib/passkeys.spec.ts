import {
  createFakeEmailSender,
  createFakeSmsSender,
  createFakeWhatsAppSender,
  createMessenger,
} from '@hk/core/comms/application';
import { IDENTITY_ERRORS, type Identifier } from '@hk/core/identity/domain';
import { sequentialIds } from '@hk/platform/test-kit';
import { FixedClock, isDomainError } from '@hk/platform/universal';
import {
  passkeyChallengeConformance,
  passkeyRepositoryConformance,
} from './conformance';
import {
  FAKE_PASSKEY_SITE,
  FakePasskeyDevice,
  InMemoryPasskeyChallengeRepository,
  InMemoryPasskeyRepository,
  createFakePasskeyVerifier,
  createInMemoryIdentityStore,
  createTestOtpCodec,
  createTestTokenCodec,
  insecureTestPasswordHasher,
  type InMemoryIdentityStore,
} from './in-memory';
import {
  PASSKEY_USE_CASES,
  createPasskeys,
  type PasskeyCeremonyStart,
  type Passkeys,
} from './passkeys';
import { createSessions, type Sessions } from './sessions';

// Every phone number, address and credential in this file is invented.

const START = '2026-11-28T09:00:00.000Z';
const phoneOf = (n: number): Identifier => ({
  kind: 'phone',
  value: `+23760000000${n}`,
});

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

describe('passkeys', () => {
  let store: InMemoryIdentityStore;
  let clock: FixedClock;
  let verifier: ReturnType<typeof createFakePasskeyVerifier>;
  let passkeys: Passkeys;
  let sessions: Sessions;
  let newId: () => string;

  const wait = (seconds: number): void => clock.advance(seconds * 1000);

  /** An active user with a verified phone. */
  const user = async (n = 1, name = 'Ada Example'): Promise<string> => {
    const created = await store.users.create({
      id: newId(),
      name,
      locale: 'en',
      identifiers: [phoneOf(n)],
      passwordHash: null,
      createdAt: START,
    });
    await store.users.markIdentifierVerified(created.id, phoneOf(n), START);
    return created.id;
  };

  /** Registers a passkey held by `device` for a user. */
  const register = async (
    userId: string,
    device: FakePasskeyDevice,
    name?: string,
  ) => {
    const start = await passkeys.beginRegistration({ userId });
    return passkeys.finishRegistration({
      userId,
      challengeId: start.challengeId,
      response: device.register(start.options),
      name,
    });
  };

  const signIn = async (device: FakePasskeyDevice, deviceName?: string) => {
    const start = await passkeys.beginSignIn();
    return passkeys.finishSignIn({
      challengeId: start.challengeId,
      response: device.authenticate(start.options),
      deviceName,
    });
  };

  beforeEach(() => {
    store = createInMemoryIdentityStore();
    clock = new FixedClock(START);
    verifier = createFakePasskeyVerifier();
    newId = sequentialIds(5);
    const tokenCodec = createTestTokenCodec();
    passkeys = createPasskeys({
      users: store.users,
      sessions: store.sessions,
      passkeys: store.passkeys,
      passkeyChallenges: store.passkeyChallenges,
      unitOfWork: store.unitOfWork,
      verifier,
      tokenCodec,
      clock,
      newId,
    });
    sessions = createSessions({
      users: store.users,
      otps: store.otps,
      sessions: store.sessions,
      passwordAttempts: store.passwordAttempts,
      unitOfWork: store.unitOfWork,
      passwordHasher: insecureTestPasswordHasher,
      otpCodec: createTestOtpCodec(),
      tokenCodec,
      messenger: createMessenger({
        sms: createFakeSmsSender(clock),
        whatsapp: createFakeWhatsAppSender(clock),
        email: createFakeEmailSender(clock),
      }),
      clock,
      newId,
      appName: 'HK',
    });
  });

  it('declares that no passkey use case runs offline', () => {
    for (const useCase of Object.values(PASSKEY_USE_CASES)) {
      expect(useCase.offline).toBe(false);
      expect(useCase.name).toMatch(/^core\.identity\.[a-z_]+$/);
    }
    expect(Object.keys(PASSKEY_USE_CASES)).toHaveLength(7);
  });

  describe('registering', () => {
    it('sends the device options that name the person, and keeps the challenge five minutes', async () => {
      const userId = await user();
      const start = await passkeys.beginRegistration({ userId });
      expect(start).toEqual({
        challengeId: expect.any(String),
        expiresAt: '2026-11-28T09:05:00.000Z',
        options: expect.objectContaining({
          challenge: verifier.issued[0],
          user: {
            id: userId,
            name: '+237600000001',
            displayName: 'Ada Example',
          },
          excludeCredentials: [],
        }),
      });
      expect(store.passkeyChallenges.size()).toBe(1);
    });

    it('stores the passkey the device made', async () => {
      const userId = await user();
      const device = new FakePasskeyDevice('credential-phone');
      const summary = await register(userId, device, '  My\tphone ');
      expect(summary).toEqual({
        id: expect.any(String),
        name: 'My phone',
        createdAt: START,
        lastUsedAt: null,
        multiDevice: true,
        backedUp: true,
      });
      expect(
        await store.passkeys.findByCredentialId('credential-phone'),
      ).toEqual({
        id: summary.id,
        userId,
        credentialId: 'credential-phone',
        publicKey: device.publicKey,
        signCount: 0,
        transports: ['internal'],
        multiDevice: true,
        backedUp: true,
        name: 'My phone',
        createdAt: START,
        lastUsedAt: null,
      });
      // The challenge is used up.
      expect(store.passkeyChallenges.size()).toBe(0);
    });

    it('names an unnamed passkey by its number', async () => {
      const userId = await user();
      expect((await register(userId, new FakePasskeyDevice('c-1'))).name).toBe(
        'Passkey 1',
      );
      expect(
        (await register(userId, new FakePasskeyDevice('c-2'), '   ')).name,
      ).toBe('Passkey 2');
    });

    it('tells the device which passkeys the person already has', async () => {
      const userId = await user();
      await register(userId, new FakePasskeyDevice('c-1'));
      const start = await passkeys.beginRegistration({ userId });
      expect(start.options['excludeCredentials']).toEqual([
        { id: 'c-1', transports: ['internal'] },
      ]);
    });

    it.each<[string, (device: FakePasskeyDevice) => void]>([
      [
        'made on another site',
        (device) => {
          device.origin = 'https://evil.example.test';
        },
      ],
      [
        'made without the device verifying the person',
        (device) => {
          device.userVerified = false;
        },
      ],
    ])('refuses a response %s', async (_name, spoil) => {
      const userId = await user();
      const device = new FakePasskeyDevice('c-1');
      spoil(device);
      expect(await codeOf(() => register(userId, device))).toBe(
        IDENTITY_ERRORS.PASSKEY_INVALID,
      );
      expect(await store.passkeys.listForUser(userId)).toEqual([]);
    });

    it.each<[string, unknown]>([
      ['nothing', undefined],
      ['null', null],
      ['a string', 'credential'],
      ['an empty object', {}],
      ['a sign-in response', { fake: 'authentication', credentialId: 'c-1' }],
    ])('refuses %s as a response', async (_name, response) => {
      const userId = await user();
      const start = await passkeys.beginRegistration({ userId });
      expect(
        await codeOf(() =>
          passkeys.finishRegistration({
            userId,
            challengeId: start.challengeId,
            response,
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
    });

    it('gives a challenge one try: a failed response uses it up', async () => {
      const userId = await user();
      const device = new FakePasskeyDevice('c-1');
      const start = await passkeys.beginRegistration({ userId });
      await failure(() =>
        passkeys.finishRegistration({
          userId,
          challengeId: start.challengeId,
          response: { broken: true },
        }),
      );
      // The right response, now too late.
      expect(
        await codeOf(() =>
          passkeys.finishRegistration({
            userId,
            challengeId: start.challengeId,
            response: device.register(start.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
      expect(await store.passkeys.listForUser(userId)).toEqual([]);
    });

    it('does not accept a response made for an earlier challenge', async () => {
      const userId = await user();
      const device = new FakePasskeyDevice('c-1');
      const first = await passkeys.beginRegistration({ userId });
      const second = await passkeys.beginRegistration({ userId });
      expect(
        await codeOf(() =>
          passkeys.finishRegistration({
            userId,
            challengeId: second.challengeId,
            response: device.register(first.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
    });

    it('accepts a response until five minutes have passed, and not at five', async () => {
      const userId = await user();
      const early = await passkeys.beginRegistration({ userId });
      wait(299);
      await passkeys.finishRegistration({
        userId,
        challengeId: early.challengeId,
        response: new FakePasskeyDevice('c-1').register(early.options),
      });
      const late = await passkeys.beginRegistration({ userId });
      wait(300);
      expect(
        await codeOf(() =>
          passkeys.finishRegistration({
            userId,
            challengeId: late.challengeId,
            response: new FakePasskeyDevice('c-2').register(late.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
    });

    it('does not let one person finish a registration another started', async () => {
      const ada = await user(1);
      const ben = await user(2, 'Ben Example');
      const start = await passkeys.beginRegistration({ userId: ada });
      expect(
        await codeOf(() =>
          passkeys.finishRegistration({
            userId: ben,
            challengeId: start.challengeId,
            response: new FakePasskeyDevice('c-1').register(start.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
      expect(await store.passkeys.listForUser(ben)).toEqual([]);
    });

    it('does not accept a sign-in challenge for registering', async () => {
      const userId = await user();
      const start = await passkeys.beginSignIn();
      expect(
        await codeOf(() =>
          passkeys.finishRegistration({
            userId,
            challengeId: start.challengeId,
            response: new FakePasskeyDevice('c-1').register(start.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
    });

    it.each(['no-such-challenge', '', 42, null, 'x'.repeat(500)])(
      'refuses %j as a challenge id',
      async (challengeId) => {
        const userId = await user();
        expect(
          await codeOf(() =>
            passkeys.finishRegistration({
              userId,
              challengeId: challengeId as string,
              response: {},
            }),
          ),
        ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
      },
    );

    it('registers one credential once, for one account', async () => {
      const ada = await user(1);
      const ben = await user(2, 'Ben Example');
      const device = new FakePasskeyDevice('c-1');
      await register(ada, device);
      for (const userId of [ada, ben]) {
        const error = await failure(() => register(userId, device));
        expect(error.code).toBe(IDENTITY_ERRORS.PASSKEY_ALREADY_REGISTERED);
        expect(error.kind).toBe('conflict');
      }
      expect(await store.passkeys.listForUser(ben)).toEqual([]);
    });

    it('allows ten passkeys and refuses to start an eleventh', async () => {
      const userId = await user();
      for (let n = 1; n <= 10; n += 1) {
        await register(userId, new FakePasskeyDevice(`c-${n}`));
      }
      const error = await failure(() => passkeys.beginRegistration({ userId }));
      expect(error.code).toBe(IDENTITY_ERRORS.PASSKEY_LIMIT);
      expect(error.details).toEqual({ max: 10 });
    });

    it('holds the limit when two registrations were started with room for one', async () => {
      const userId = await user();
      for (let n = 1; n <= 9; n += 1) {
        await register(userId, new FakePasskeyDevice(`c-${n}`));
      }
      const a = await passkeys.beginRegistration({ userId });
      const b = await passkeys.beginRegistration({ userId });
      await passkeys.finishRegistration({
        userId,
        challengeId: a.challengeId,
        response: new FakePasskeyDevice('c-a').register(a.options),
      });
      expect(
        await codeOf(() =>
          passkeys.finishRegistration({
            userId,
            challengeId: b.challengeId,
            response: new FakePasskeyDevice('c-b').register(b.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_LIMIT);
      expect(await store.passkeys.listForUser(userId)).toHaveLength(10);
    });

    it('is for accounts that may sign in', async () => {
      const pending = await store.users.create({
        id: newId(),
        name: 'Ada Example',
        locale: 'en',
        identifiers: [phoneOf(1)],
        passwordHash: null,
        createdAt: START,
      });
      const suspended = await user(2);
      store.users.setStatus(suspended, 'suspended');
      for (const userId of [pending.id, suspended, 'no-such-user']) {
        expect(await codeOf(() => passkeys.beginRegistration({ userId }))).toBe(
          IDENTITY_ERRORS.USER_NOT_FOUND,
        );
      }
      expect(store.passkeyChallenges.size()).toBe(0);
    });

    it('stores nothing when the person is suspended between starting and finishing', async () => {
      const userId = await user();
      const start = await passkeys.beginRegistration({ userId });
      store.users.setStatus(userId, 'suspended');
      expect(
        await codeOf(() =>
          passkeys.finishRegistration({
            userId,
            challengeId: start.challengeId,
            response: new FakePasskeyDevice('c-1').register(start.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
      expect(await store.passkeys.listForUser(userId)).toEqual([]);
    });
  });

  describe('signing in', () => {
    let userId: string;
    let device: FakePasskeyDevice;

    beforeEach(async () => {
      userId = await user();
      device = new FakePasskeyDevice('credential-phone');
      await register(userId, device);
    });

    /** Begins a sign-in and finishes it with whatever `respond` returns. */
    const attempt = async (
      respond: (start: PasskeyCeremonyStart) => unknown,
    ): Promise<string> => {
      const start = await passkeys.beginSignIn();
      return codeOf(() =>
        passkeys.finishSignIn({
          challengeId: start.challengeId,
          response: respond(start),
        }),
      );
    };

    it('starts by naming no account at all', async () => {
      const start = await passkeys.beginSignIn();
      expect(start).toEqual({
        challengeId: expect.any(String),
        expiresAt: '2026-11-28T09:05:00.000Z',
        options: {
          challenge: verifier.issued[verifier.issued.length - 1],
          rpId: FAKE_PASSKEY_SITE.rpId,
          userVerification: 'required',
        },
      });
      expect(JSON.stringify(start)).not.toContain(userId);
      expect(JSON.stringify(start)).not.toContain('credential-phone');
    });

    it('signs the person in and starts a session', async () => {
      wait(60);
      const tokens = await signIn(device, 'Samsung A14');
      expect(tokens.userId).toBe(userId);
      expect(await store.sessions.findById(tokens.sessionId)).toMatchObject({
        userId,
        method: 'passkey',
        deviceName: 'Samsung A14',
      });
      expect(
        await sessions.authenticate({ accessToken: tokens.accessToken }),
      ).toMatchObject({ userId, method: 'passkey' });
      expect(
        (await store.passkeys.findByCredentialId('credential-phone'))
          ?.lastUsedAt,
      ).toBe('2026-11-28T09:01:00.000Z');
      expect(store.passkeyChallenges.size()).toBe(0);
    });

    it('lets a device that does not count its uses sign in again and again', async () => {
      await signIn(device);
      await signIn(device);
      const tokens = await signIn(device);
      expect(tokens.userId).toBe(userId);
      expect(
        (await store.passkeys.findByCredentialId('credential-phone'))
          ?.signCount,
      ).toBe(0);
    });

    it('follows the count of a device that counts', async () => {
      device.counts = true;
      await signIn(device);
      await signIn(device);
      expect(
        (await store.passkeys.findByCredentialId('credential-phone'))
          ?.signCount,
      ).toBe(2);
    });

    it('refuses a copy of a passkey whose count has fallen behind', async () => {
      device.counts = true;
      await signIn(device);
      await signIn(device);
      await signIn(device);
      // A copy made after the first use still thinks the count is 1.
      const copy = new FakePasskeyDevice('credential-phone');
      copy.userId = userId;
      copy.counts = true;
      copy.signCount = 1;
      const before = store.sessions.allPairs().length;
      expect(await attempt((start) => copy.authenticate(start.options))).toBe(
        IDENTITY_ERRORS.PASSKEY_INVALID,
      );
      expect(store.sessions.allPairs()).toHaveLength(before);
      expect(
        (await store.passkeys.findByCredentialId('credential-phone'))
          ?.signCount,
      ).toBe(3);
    });

    it.each<[string, (start: PasskeyCeremonyStart) => unknown]>([
      [
        'a response made on another site',
        (start) => {
          device.origin = 'https://evil.example.test';
          return device.authenticate(start.options);
        },
      ],
      [
        'a response made without the device verifying the person',
        (start) => {
          device.userVerified = false;
          return device.authenticate(start.options);
        },
      ],
      [
        'a forged signature',
        (start) => ({
          ...device.authenticate(start.options),
          signature: 'signed-with(private-of:someone-else)',
        }),
      ],
      [
        'a passkey that is not registered',
        (start) => new FakePasskeyDevice('unknown').authenticate(start.options),
      ],
      [
        'a passkey that says it belongs to someone else',
        (start) => {
          device.userId = 'another-user';
          return device.authenticate(start.options);
        },
      ],
      ['an empty object', () => ({})],
      ['nothing', () => undefined],
      ['a registration response', (start) => device.register(start.options)],
    ])('refuses %s', async (_name, respond) => {
      expect(await attempt(respond)).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
      expect(store.sessions.allPairs()).toEqual([]);
    });

    it('accepts a response once: a captured one cannot be sent again', async () => {
      const start = await passkeys.beginSignIn();
      const response = device.authenticate(start.options);
      await passkeys.finishSignIn({ challengeId: start.challengeId, response });
      expect(
        await codeOf(() =>
          passkeys.finishSignIn({ challengeId: start.challengeId, response }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
      expect(store.sessions.allPairs()).toHaveLength(1);
    });

    it('does not accept a response made for an earlier challenge', async () => {
      const first = await passkeys.beginSignIn();
      const captured = device.authenticate(first.options);
      expect(await attempt(() => captured)).toBe(
        IDENTITY_ERRORS.PASSKEY_INVALID,
      );
    });

    it('gives a challenge one try, even when the first response was wrong', async () => {
      const start = await passkeys.beginSignIn();
      await failure(() =>
        passkeys.finishSignIn({ challengeId: start.challengeId, response: {} }),
      );
      expect(
        await codeOf(() =>
          passkeys.finishSignIn({
            challengeId: start.challengeId,
            response: device.authenticate(start.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
    });

    it('accepts a response until five minutes have passed, and not at five', async () => {
      const early = await passkeys.beginSignIn();
      wait(299);
      await passkeys.finishSignIn({
        challengeId: early.challengeId,
        response: device.authenticate(early.options),
      });
      const late = await passkeys.beginSignIn();
      wait(300);
      expect(
        await codeOf(() =>
          passkeys.finishSignIn({
            challengeId: late.challengeId,
            response: device.authenticate(late.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
    });

    it('does not accept a registration challenge for signing in', async () => {
      const start = await passkeys.beginRegistration({ userId });
      expect(
        await codeOf(() =>
          passkeys.finishSignIn({
            challengeId: start.challengeId,
            response: device.authenticate(start.options),
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
    });

    it('does not sign a suspended person in, and records no use', async () => {
      store.users.setStatus(userId, 'suspended');
      expect(await attempt((start) => device.authenticate(start.options))).toBe(
        IDENTITY_ERRORS.PASSKEY_INVALID,
      );
      expect(
        (await store.passkeys.findByCredentialId('credential-phone'))
          ?.lastUsedAt,
      ).toBeNull();
    });

    it('signs each person in with their own passkey', async () => {
      const ben = await user(2, 'Ben Example');
      const bensDevice = new FakePasskeyDevice('credential-ben');
      await register(ben, bensDevice);
      expect((await signIn(bensDevice)).userId).toBe(ben);
      expect((await signIn(device)).userId).toBe(userId);
    });
  });

  describe('managing passkeys', () => {
    it('lists them oldest first, with no key material', async () => {
      const userId = await user();
      const ben = await user(2, 'Ben Example');
      const phone = new FakePasskeyDevice('credential-phone');
      await register(userId, phone, 'Phone');
      wait(60);
      const key = new FakePasskeyDevice('credential-key');
      key.multiDevice = false;
      key.backedUp = false;
      await register(userId, key, 'Security key');
      await register(ben, new FakePasskeyDevice('credential-ben'));
      wait(60);
      await signIn(key);

      const listed = await passkeys.listPasskeys({ userId });
      expect(listed).toEqual([
        {
          id: expect.any(String),
          name: 'Phone',
          createdAt: START,
          lastUsedAt: null,
          multiDevice: true,
          backedUp: true,
        },
        {
          id: expect.any(String),
          name: 'Security key',
          createdAt: '2026-11-28T09:01:00.000Z',
          lastUsedAt: '2026-11-28T09:02:00.000Z',
          multiDevice: false,
          backedUp: false,
        },
      ]);
      const text = JSON.stringify(listed);
      expect(text).not.toContain('credential-');
      expect(text).not.toContain('public-key');
    });

    it('renames a person’s own passkey', async () => {
      const userId = await user();
      const ben = await user(2, 'Ben Example');
      const { id: passkeyId } = await register(
        userId,
        new FakePasskeyDevice('c-1'),
      );
      await passkeys.renamePasskey({
        userId,
        passkeyId,
        name: ' Work\nlaptop ',
      });
      expect((await passkeys.listPasskeys({ userId }))[0]?.name).toBe(
        'Work laptop',
      );

      const notTheirs = await failure(() =>
        passkeys.renamePasskey({ userId: ben, passkeyId, name: 'Mine now' }),
      );
      expect(notTheirs.code).toBe(IDENTITY_ERRORS.PASSKEY_NOT_FOUND);
      expect(notTheirs.kind).toBe('not-found');
      expect(
        await codeOf(() =>
          passkeys.renamePasskey({ userId, passkeyId, name: '   ' }),
        ),
      ).toBe(IDENTITY_ERRORS.NAME_INVALID);
      expect((await passkeys.listPasskeys({ userId }))[0]?.name).toBe(
        'Work laptop',
      );
    });

    it('removes a person’s own passkey, which then no longer signs in', async () => {
      const userId = await user();
      const ben = await user(2, 'Ben Example');
      const device = new FakePasskeyDevice('c-1');
      const { id: passkeyId } = await register(userId, device);
      const tokens = await signIn(device);

      expect(
        await codeOf(() => passkeys.removePasskey({ userId: ben, passkeyId })),
      ).toBe(IDENTITY_ERRORS.PASSKEY_NOT_FOUND);
      await passkeys.removePasskey({ userId, passkeyId });
      expect(await passkeys.listPasskeys({ userId })).toEqual([]);
      expect(await codeOf(() => signIn(device))).toBe(
        IDENTITY_ERRORS.PASSKEY_INVALID,
      );
      expect(
        await codeOf(() => passkeys.removePasskey({ userId, passkeyId })),
      ).toBe(IDENTITY_ERRORS.PASSKEY_NOT_FOUND);
      // A session it started earlier is not ended by removing the passkey;
      // signing out everywhere does that.
      expect(
        (await sessions.authenticate({ accessToken: tokens.accessToken }))
          .userId,
      ).toBe(userId);
      // And the same device can be registered afresh.
      expect((await register(userId, device)).name).toBe('Passkey 1');
    });
  });

  describe('privacy', () => {
    it('gives the same answer for every way a sign-in can fail', async () => {
      const userId = await user();
      const device = new FakePasskeyDevice('credential-phone');
      await register(userId, device);
      const answers: string[] = [];
      const record = async (
        respond: (start: PasskeyCeremonyStart) => unknown,
      ) => {
        const start = await passkeys.beginSignIn();
        const error = await failure(() =>
          passkeys.finishSignIn({
            challengeId: start.challengeId,
            response: respond(start),
          }),
        );
        answers.push(JSON.stringify(error.toJSON()));
      };
      await record((start) =>
        new FakePasskeyDevice('unknown').authenticate(start.options),
      );
      await record((start) => ({
        ...device.authenticate(start.options),
        signature: 'forged',
      }));
      await record(() => ({}));
      const error = await failure(() =>
        passkeys.finishSignIn({ challengeId: 'no-such', response: {} }),
      );
      answers.push(JSON.stringify(error.toJSON()));
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).not.toMatch(/credential-|fake-challenge|600000/);
    });
  });
});

describe('InMemoryPasskeyRepository conformance', () => {
  for (const testCase of passkeyRepositoryConformance) {
    it(testCase.name, () =>
      testCase.run({
        passkeys: new InMemoryPasskeyRepository(),
        within: (action) => action(),
        ensureUser: async () => undefined,
      }),
    );
  }
});

describe('InMemoryPasskeyChallengeRepository conformance', () => {
  for (const testCase of passkeyChallengeConformance) {
    it(testCase.name, () =>
      testCase.run({
        passkeyChallenges: new InMemoryPasskeyChallengeRepository(),
        within: (action) => action(),
      }),
    );
  }
});
