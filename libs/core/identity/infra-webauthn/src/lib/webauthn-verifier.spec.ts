import { generateKeyPairSync } from 'node:crypto';
import {
  createInMemoryIdentityStore,
  createPasskeys,
  createTestTokenCodec,
  type PasskeyVerifier,
  type RegisteredCredential,
} from '@hk/core/identity/application';
import { IDENTITY_ERRORS } from '@hk/core/identity/domain';
import { sequentialIds } from '@hk/platform/test-kit';
import { FixedClock, isDomainError } from '@hk/platform/universal';
import {
  VirtualAuthenticator,
  type CeremonyOptions,
} from './virtual-authenticator';
import {
  WEBAUTHN_ALGORITHMS,
  createWebAuthnVerifier,
} from './webauthn-verifier';

// Every domain, user and key in this file is invented. The keys are made
// fresh for each test and exist only in memory.

const SITE = { rpId: 'hk.example', origin: 'https://app.hk.example' };
const USER_ID = '018f0000-0000-7000-8000-0000000000a1';

const verifierFor = (
  origins: readonly string[] = [SITE.origin],
): PasskeyVerifier =>
  createWebAuthnVerifier({ rpId: SITE.rpId, rpName: 'HK', origins });

const ceremony = (made: {
  options: Readonly<Record<string, unknown>>;
}): CeremonyOptions => made.options as unknown as CeremonyOptions;

describe('WebAuthn verifier', () => {
  let verifier: PasskeyVerifier;
  let device: VirtualAuthenticator;

  /** Registers the device and returns what the verifier made of it. */
  const registered = async (): Promise<RegisteredCredential> => {
    const made = await verifier.registrationOptions({
      userId: USER_ID,
      userName: '+237600000001',
      displayName: 'Ada Example',
      exclude: [],
    });
    const credential = await verifier.verifyRegistration({
      response: device.register(ceremony(made)),
      challenge: made.challenge,
    });
    if (!credential) throw new Error('registration was not accepted');
    return credential;
  };

  beforeEach(() => {
    verifier = verifierFor();
    device = new VirtualAuthenticator(SITE);
  });

  describe('registration options', () => {
    it('ask for a discoverable passkey with user verification, and no attestation', async () => {
      const made = await verifier.registrationOptions({
        userId: USER_ID,
        userName: '+237600000001',
        displayName: 'Ada Example',
        exclude: [{ credentialId: 'ZXhpc3Rpbmc', transports: ['internal'] }],
      });
      expect(made.options).toMatchObject({
        challenge: made.challenge,
        rp: { id: 'hk.example', name: 'HK' },
        user: { name: '+237600000001', displayName: 'Ada Example' },
        attestation: 'none',
        timeout: 300_000,
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        excludeCredentials: [
          { id: 'ZXhpc3Rpbmc', type: 'public-key', transports: ['internal'] },
        ],
      });
      const algorithms = (
        made.options['pubKeyCredParams'] as { alg: number }[]
      ).map((item) => item.alg);
      expect(algorithms).toEqual([...WEBAUTHN_ALGORITHMS]);
    });

    it('carry the user id as the user handle, and nothing personal in it', async () => {
      const made = await verifier.registrationOptions({
        userId: USER_ID,
        userName: '+237600000001',
        displayName: 'Ada Example',
        exclude: [],
      });
      const handle = (made.options['user'] as { id: string }).id;
      expect(Buffer.from(handle, 'base64url').toString('utf8')).toBe(USER_ID);
    });

    it('make a fresh challenge of at least 256 bits each time', async () => {
      const challenges = new Set<string>();
      for (let n = 0; n < 50; n += 1) {
        const made =
          n % 2 === 0
            ? await verifier.authenticationOptions()
            : await verifier.registrationOptions({
                userId: USER_ID,
                userName: 'x',
                displayName: 'x',
                exclude: [],
              });
        expect(
          Buffer.from(made.challenge, 'base64url').length,
        ).toBeGreaterThanOrEqual(32);
        challenges.add(made.challenge);
      }
      expect(challenges.size).toBe(50);
    });
  });

  describe('verifying a registration', () => {
    it('accepts a real response and returns the credential to store', async () => {
      const credential = await registered();
      expect(credential).toEqual({
        credentialId: device.id,
        publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{60,}$/),
        signCount: 0,
        transports: ['internal', 'hybrid'],
        multiDevice: true,
        backedUp: true,
      });
    });

    it('reports a single-device passkey that is not backed up as such', async () => {
      device.multiDevice = false;
      expect(await registered()).toMatchObject({
        multiDevice: false,
        backedUp: false,
      });
    });

    it.each<[string, (device: VirtualAuthenticator) => void]>([
      [
        'made on another origin',
        (d) => {
          d.origin = 'https://evil.example';
        },
      ],
      [
        'made on a look-alike origin',
        (d) => {
          d.origin = 'https://app.hk.example.evil.example';
        },
      ],
      [
        'made over plain http',
        (d) => {
          d.origin = 'http://app.hk.example';
        },
      ],
      [
        'made for another site',
        (d) => {
          d.rpId = 'other.example';
        },
      ],
      [
        'made without verifying the person',
        (d) => {
          d.userVerified = false;
        },
      ],
      [
        'made without the person present',
        (d) => {
          d.userPresent = false;
        },
      ],
    ])('refuses a response %s', async (_name, spoil) => {
      spoil(device);
      const made = await verifier.registrationOptions({
        userId: USER_ID,
        userName: 'x',
        displayName: 'x',
        exclude: [],
      });
      expect(
        await verifier.verifyRegistration({
          response: device.register(ceremony(made)),
          challenge: made.challenge,
        }),
      ).toBeNull();
    });

    it('refuses a response to another challenge', async () => {
      const first = await verifier.registrationOptions({
        userId: USER_ID,
        userName: 'x',
        displayName: 'x',
        exclude: [],
      });
      const second = await verifier.registrationOptions({
        userId: USER_ID,
        userName: 'x',
        displayName: 'x',
        exclude: [],
      });
      expect(
        await verifier.verifyRegistration({
          response: device.register(ceremony(first)),
          challenge: second.challenge,
        }),
      ).toBeNull();
    });

    it('refuses a sign-in response offered as a registration', async () => {
      const made = await verifier.registrationOptions({
        userId: USER_ID,
        userName: 'x',
        displayName: 'x',
        exclude: [],
      });
      expect(
        await verifier.verifyRegistration({
          response: device.authenticate(ceremony(made)),
          challenge: made.challenge,
        }),
      ).toBeNull();
    });

    it.each<[string, unknown]>([
      ['nothing', undefined],
      ['null', null],
      ['a string', 'response'],
      ['a number', 7],
      ['an array', []],
      ['an empty object', {}],
      [
        'an object of the right shape with rubbish in it',
        {
          id: 'abc',
          rawId: 'abc',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: 'e30', attestationObject: 'AAAA' },
        },
      ],
    ])('answers null, without throwing, for %s', async (_name, response) => {
      expect(
        await verifier.verifyRegistration({
          response,
          challenge: 'Y2hhbGxlbmdl',
        }),
      ).toBeNull();
    });
  });

  describe('verifying a sign-in', () => {
    let credential: RegisteredCredential;

    beforeEach(async () => {
      credential = await registered();
    });

    const verify = async (
      respond: (options: CeremonyOptions) => unknown,
      stored: RegisteredCredential = credential,
    ) => {
      const made = await verifier.authenticationOptions();
      return verifier.verifyAuthentication({
        response: respond(ceremony(made)),
        challenge: made.challenge,
        credential: stored,
      });
    };

    it('sends options that name no credential and require user verification', async () => {
      const made = await verifier.authenticationOptions();
      expect(made.options).toMatchObject({
        challenge: made.challenge,
        rpId: 'hk.example',
        userVerification: 'required',
        timeout: 300_000,
      });
      expect(made.options['allowCredentials'] ?? []).toEqual([]);
    });

    it('accepts a real signature and says whose passkey it is', async () => {
      expect(await verify((options) => device.authenticate(options))).toEqual({
        signCount: 0,
        backedUp: true,
        userId: USER_ID,
      });
    });

    it('reports the count of a device that counts', async () => {
      device.counts = true;
      const first = await verify((options) => device.authenticate(options));
      expect(first?.signCount).toBe(1);
      const second = await verify((options) => device.authenticate(options), {
        ...credential,
        signCount: 1,
      });
      expect(second?.signCount).toBe(2);
    });

    it('answers with no user when the device gives no user handle', async () => {
      device.userHandle = null;
      expect(
        (await verify((options) => device.authenticate(options)))?.userId,
      ).toBeNull();
    });

    it('reads the credential id a response claims, without trusting it', () => {
      const response = device.authenticate({ challenge: 'Y2hhbGxlbmdl' });
      expect(verifier.credentialIdOf(response)).toBe(device.id);
      for (const bad of [
        undefined,
        null,
        'id',
        {},
        { id: 7 },
        { id: 'not base64url!' },
        { id: 'a'.repeat(5000) },
        [device.id],
      ]) {
        expect(verifier.credentialIdOf(bad)).toBeNull();
      }
    });

    it.each<[string, (device: VirtualAuthenticator) => void]>([
      [
        'made on another origin',
        (d) => {
          d.origin = 'https://evil.example';
        },
      ],
      [
        'made for another site',
        (d) => {
          d.rpId = 'other.example';
        },
      ],
      [
        'made without verifying the person',
        (d) => {
          d.userVerified = false;
        },
      ],
      [
        'signed with another key',
        (d) => {
          d.privateKey = generateKeyPairSync('ec', {
            namedCurve: 'P-256',
          }).privateKey;
        },
      ],
    ])('refuses a response %s', async (_name, spoil) => {
      spoil(device);
      expect(
        await verify((options) => device.authenticate(options)),
      ).toBeNull();
    });

    it('refuses a response to another challenge', async () => {
      const earlier = await verifier.authenticationOptions();
      const captured = device.authenticate(ceremony(earlier));
      expect(await verify(() => captured)).toBeNull();
    });

    it('refuses a response altered after it was signed', async () => {
      const tamper = (
        change: (
          response: ReturnType<VirtualAuthenticator['authenticate']>,
        ) => void,
      ) =>
        verify((options) => {
          const response = device.authenticate(options);
          change(response);
          return response;
        });
      // The authenticator data with its "user verified" bit flipped on would
      // be the prize; here every part is altered in turn.
      expect(
        await tamper((response) => {
          const bytes = Buffer.from(
            response.response.authenticatorData,
            'base64url',
          );
          bytes[33] = (bytes[33] ?? 0) ^ 0xff;
          response.response.authenticatorData = bytes.toString('base64url');
        }),
      ).toBeNull();
      expect(
        await tamper((response) => {
          const bytes = Buffer.from(response.response.signature, 'base64url');
          const last = bytes.length - 1;
          bytes[last] = (bytes[last] ?? 0) ^ 0x01;
          response.response.signature = bytes.toString('base64url');
        }),
      ).toBeNull();
      expect(
        await tamper((response) => {
          const data = JSON.parse(
            Buffer.from(
              response.response.clientDataJSON,
              'base64url',
            ).toString(),
          ) as Record<string, unknown>;
          data['crossOrigin'] = true;
          response.response.clientDataJSON = Buffer.from(
            JSON.stringify(data),
          ).toString('base64url');
        }),
      ).toBeNull();
    });

    it('cannot be talked into "user verified" by flipping the flag', async () => {
      device.userVerified = false;
      const made = await verifier.authenticationOptions();
      const response = device.authenticate(ceremony(made));
      const bytes = Buffer.from(
        response.response.authenticatorData,
        'base64url',
      );
      bytes[32] = (bytes[32] ?? 0) | 0x04; // set the UV bit after signing
      response.response.authenticatorData = bytes.toString('base64url');
      expect(
        await verifier.verifyAuthentication({
          response,
          challenge: made.challenge,
          credential,
        }),
      ).toBeNull();
    });

    it('refuses one passkey’s signature for another passkey', async () => {
      const other = new VirtualAuthenticator(SITE);
      // The response claims the registered credential's id but is signed by
      // a different device.
      expect(
        await verify((options) => ({
          ...other.authenticate(options),
          id: device.id,
          rawId: device.id,
        })),
      ).toBeNull();
    });

    it('refuses a count that did not go up, for a device that counts', async () => {
      device.counts = true;
      device.signCount = 4;
      // The device reports 5; the server already has 5 on record.
      expect(
        await verify((options) => device.authenticate(options), {
          ...credential,
          signCount: 5,
        }),
      ).toBeNull();
    });

    it('refuses a registration response offered as a sign-in', async () => {
      expect(await verify((options) => device.register(options))).toBeNull();
    });

    it.each<[string, unknown]>([
      ['nothing', undefined],
      ['null', null],
      ['a string', 'response'],
      ['an array', []],
      ['an empty object', {}],
    ])('answers null, without throwing, for %s', async (_name, response) => {
      expect(await verify(() => response)).toBeNull();
    });

    it('refuses a stored public key that is not a key', async () => {
      expect(
        await verify((options) => device.authenticate(options), {
          ...credential,
          publicKey: 'bm90LWEta2V5',
        }),
      ).toBeNull();
    });
  });

  describe('several origins', () => {
    it('accepts each configured origin and no other', async () => {
      verifier = verifierFor([
        'https://app.hk.example',
        'https://hk.example',
        'android:apk-key-hash:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE',
      ]);
      for (const origin of [
        'https://app.hk.example',
        'https://hk.example',
        'android:apk-key-hash:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE',
      ]) {
        device = new VirtualAuthenticator({ rpId: SITE.rpId, origin });
        expect((await registered()).credentialId).toBe(device.id);
      }
      device = new VirtualAuthenticator({
        rpId: SITE.rpId,
        origin: 'https://admin.hk.example',
      });
      await expect(registered()).rejects.toThrow(
        'registration was not accepted',
      );
    });
  });

  describe('configuration', () => {
    const make = (
      overrides: Partial<Parameters<typeof createWebAuthnVerifier>[0]>,
    ) =>
      createWebAuthnVerifier({
        rpId: 'hk.example',
        rpName: 'HK',
        origins: ['https://app.hk.example'],
        ...overrides,
      });

    it.each<
      [string, Partial<Parameters<typeof createWebAuthnVerifier>[0]>, RegExp]
    >([
      ['an rpId with a scheme', { rpId: 'https://hk.example' }, /rpId/],
      ['an rpId with a port', { rpId: 'hk.example:443' }, /rpId/],
      ['an rpId in upper case', { rpId: 'HK.example' }, /rpId/],
      ['an empty rpId', { rpId: '' }, /rpId/],
      ['an empty name', { rpName: '  ' }, /rpName/],
      ['no origin', { origins: [] }, /at least one origin/],
      ['an http origin', { origins: ['http://app.hk.example'] }, /https/],
      [
        'an origin with a path',
        { origins: ['https://app.hk.example/login'] },
        /bare origin/,
      ],
      [
        'an origin with a trailing slash',
        { origins: ['https://app.hk.example/'] },
        /bare origin/,
      ],
      [
        'an origin on another domain',
        { origins: ['https://evil.example'] },
        /subdomain/,
      ],
      [
        'an origin that only ends like the rpId',
        { origins: ['https://nothk.example'] },
        /subdomain/,
      ],
      [
        'an origin that is not a URL',
        { origins: ['app.hk.example'] },
        /valid URL|bare origin/,
      ],
      [
        'an Android origin with no hash',
        { origins: ['android:apk-key-hash:'] },
        /valid URL|bare origin|https/,
      ],
    ])('refuses %s', (_name, overrides, message) => {
      expect(() => make(overrides)).toThrow(message);
    });

    it('accepts http on localhost, for development', () => {
      expect(() =>
        createWebAuthnVerifier({
          rpId: 'localhost',
          rpName: 'HK dev',
          origins: ['http://localhost:4200'],
        }),
      ).not.toThrow();
    });
  });

  describe('with the passkey use cases', () => {
    it('registers a real passkey and signs in with it', async () => {
      const store = createInMemoryIdentityStore();
      const clock = new FixedClock('2026-11-28T09:00:00.000Z');
      const newId = sequentialIds(3);
      const passkeys = createPasskeys({
        users: store.users,
        sessions: store.sessions,
        passkeys: store.passkeys,
        passkeyChallenges: store.passkeyChallenges,
        unitOfWork: store.unitOfWork,
        verifier,
        tokenCodec: createTestTokenCodec(),
        clock,
        newId,
      });
      const phone = { kind: 'phone', value: '+237600000001' } as const;
      const user = await store.users.create({
        id: newId(),
        name: 'Ada Example',
        locale: 'en',
        identifiers: [phone],
        passwordHash: null,
        createdAt: clock.now().toISOString(),
      });
      await store.users.markIdentifierVerified(
        user.id,
        phone,
        clock.now().toISOString(),
      );

      const registration = await passkeys.beginRegistration({
        userId: user.id,
      });
      const summary = await passkeys.finishRegistration({
        userId: user.id,
        challengeId: registration.challengeId,
        response: device.register(ceremony(registration)),
        name: 'My phone',
      });
      expect(summary).toMatchObject({ name: 'My phone', multiDevice: true });

      const start = await passkeys.beginSignIn();
      const response = device.authenticate(ceremony(start));
      const tokens = await passkeys.finishSignIn({
        challengeId: start.challengeId,
        response,
      });
      expect(tokens.userId).toBe(user.id);

      // The same signed response a second time is refused.
      let replay = 'nothing was thrown';
      try {
        await passkeys.finishSignIn({
          challengeId: start.challengeId,
          response,
        });
      } catch (error) {
        replay = isDomainError(error) ? error.code : String(error);
      }
      expect(replay).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);

      // And a device made for a look-alike site cannot sign in.
      const phished = await passkeys.beginSignIn();
      device.origin = 'https://app.hk.example.evil.example';
      let outcome = 'nothing was thrown';
      try {
        await passkeys.finishSignIn({
          challengeId: phished.challengeId,
          response: device.authenticate(ceremony(phished)),
        });
      } catch (error) {
        outcome = isDomainError(error) ? error.code : String(error);
      }
      expect(outcome).toBe(IDENTITY_ERRORS.PASSKEY_INVALID);
    });
  });
});
