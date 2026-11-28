import {
  IDENTITY_ERRORS,
  PASSKEY_RULES,
  canSignIn,
  isPasskeyChallengeUsable,
  judgeSignCount,
  parsePasskeyName,
  passkeyChallengeExpiry,
  type Passkey,
  type PasskeyCeremony,
  type PasskeyChallenge,
} from '@hk/core/identity/domain';
import type { Clock, DomainError } from '@hk/platform/universal';
import { identityFailure } from './otp-flow';
import type {
  IdentityUnitOfWork,
  PasskeyChallengeRepository,
  PasskeyRepository,
  PasskeyVerifier,
  SessionRepository,
  TokenCodec,
  UserRepository,
} from './ports';
import { createSessionStarter, type SessionTokens } from './session-starter';

/**
 * Passkeys: registering one, signing in with one, and managing them.
 *
 * None of these runs offline: each is an exchange with the server.
 */
export const PASSKEY_USE_CASES = {
  beginRegistration: {
    name: 'core.identity.begin_passkey_registration',
    offline: false,
  },
  finishRegistration: {
    name: 'core.identity.finish_passkey_registration',
    offline: false,
  },
  beginSignIn: { name: 'core.identity.begin_passkey_sign_in', offline: false },
  finishSignIn: {
    name: 'core.identity.finish_passkey_sign_in',
    offline: false,
  },
  listPasskeys: { name: 'core.identity.list_passkeys', offline: false },
  renamePasskey: { name: 'core.identity.rename_passkey', offline: false },
  removePasskey: { name: 'core.identity.remove_passkey', offline: false },
} as const;

/** What the client needs to run a ceremony on the device. */
export interface PasskeyCeremonyStart {
  /** Sent back with the device's response, so the server finds the challenge. */
  challengeId: string;
  /** Given as is to navigator.credentials.create() or .get(). */
  options: Readonly<Record<string, unknown>>;
  /** ISO 8601 instant after which the response is no longer accepted. */
  expiresAt: string;
}

/** A passkey as shown to its owner. No key material. */
export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** True when the passkey is synced across the person's devices. */
  multiDevice: boolean;
  backedUp: boolean;
}

export interface PasskeysOptions {
  users: UserRepository;
  sessions: SessionRepository;
  passkeys: PasskeyRepository;
  passkeyChallenges: PasskeyChallengeRepository;
  unitOfWork: IdentityUnitOfWork;
  verifier: PasskeyVerifier;
  tokenCodec: TokenCodec;
  clock: Clock;
  /** Makes ids. A UUID v7 generator in production. */
  newId: () => string;
}

export interface Passkeys {
  /** Starts registering a passkey for a signed-in user. */
  beginRegistration(input: { userId: string }): Promise<PasskeyCeremonyStart>;
  /** Stores the passkey the device made, once its response checks out. */
  finishRegistration(input: {
    userId: string;
    challengeId: string;
    /** What the device returned. Untrusted. */
    response: unknown;
    name?: string | null;
  }): Promise<PasskeySummary>;
  /**
   * Starts a passkey sign-in. It takes no phone number or email: the
   * passkey the person picks says whose it is, so the answer is the same
   * for everyone and reveals nothing about which accounts exist.
   */
  beginSignIn(): Promise<PasskeyCeremonyStart>;
  /** Signs in with the device's response, and starts a session. */
  finishSignIn(input: {
    challengeId: string;
    /** What the device returned. Untrusted. */
    response: unknown;
    deviceName?: string | null;
  }): Promise<SessionTokens>;
  /** The user's passkeys, oldest first. */
  listPasskeys(input: { userId: string }): Promise<PasskeySummary[]>;
  renamePasskey(input: {
    userId: string;
    passkeyId: string;
    name: string;
  }): Promise<void>;
  /**
   * Removes a passkey. The person can still sign in with a code sent to
   * their verified phone number or email, so they cannot lock themselves
   * out this way.
   */
  removePasskey(input: { userId: string; passkeyId: string }): Promise<void>;
}

const passkeyInvalid = (): DomainError =>
  identityFailure(
    IDENTITY_ERRORS.PASSKEY_INVALID,
    'The passkey could not be verified. Try again.',
  );

const passkeyNotFound = (): DomainError =>
  identityFailure(
    IDENTITY_ERRORS.PASSKEY_NOT_FOUND,
    'The passkey was not found.',
    undefined,
    'not-found',
  );

const limitReached = (): DomainError =>
  identityFailure(
    IDENTITY_ERRORS.PASSKEY_LIMIT,
    'This account has as many passkeys as are allowed. Remove one first.',
    { max: PASSKEY_RULES.maxPerUser },
    'conflict',
  );

const summaryOf = (passkey: Passkey): PasskeySummary => ({
  id: passkey.id,
  name: passkey.name,
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt,
  multiDevice: passkey.multiDevice,
  backedUp: passkey.backedUp,
});

export const createPasskeys = (options: PasskeysOptions): Passkeys => {
  const {
    users,
    passkeys,
    passkeyChallenges,
    unitOfWork,
    verifier,
    clock,
    newId,
  } = options;
  const { startSession } = createSessionStarter(options);

  const nowIso = (): string => clock.now().toISOString();

  /** Stores a challenge and returns what the client needs. */
  const openCeremony = async (
    ceremony: PasskeyCeremony,
    userId: string | null,
    made: { challenge: string; options: Readonly<Record<string, unknown>> },
  ): Promise<PasskeyCeremonyStart> => {
    const now = clock.now();
    const challenge: PasskeyChallenge = {
      id: newId(),
      ceremony,
      userId,
      challenge: made.challenge,
      createdAt: now.toISOString(),
      expiresAt: passkeyChallengeExpiry(now),
    };
    await unitOfWork.run(() => passkeyChallenges.create(challenge));
    return {
      challengeId: challenge.id,
      options: made.options,
      expiresAt: challenge.expiresAt,
    };
  };

  /**
   * Takes a challenge out of storage, in a unit of work of its own that
   * commits. Whatever happens next, the challenge is gone: a response gets
   * one try, and a failed check cannot be repeated against the same
   * challenge.
   */
  const takeChallenge = async (
    challengeId: unknown,
    ceremony: PasskeyCeremony,
    userId: string | null,
  ): Promise<PasskeyChallenge> => {
    if (typeof challengeId !== 'string' || challengeId.length > 100) {
      throw passkeyInvalid();
    }
    const taken = await unitOfWork.run(() =>
      passkeyChallenges.take(challengeId),
    );
    if (!isPasskeyChallengeUsable(taken, ceremony, userId, nowIso())) {
      throw passkeyInvalid();
    }
    return taken;
  };

  const beginRegistration: Passkeys['beginRegistration'] = async (input) => {
    const [user, existing] = await unitOfWork.run(
      async () =>
        [
          await users.findById(input.userId),
          await passkeys.listForUser(input.userId),
        ] as const,
    );
    if (!user || !canSignIn(user)) {
      throw identityFailure(
        IDENTITY_ERRORS.USER_NOT_FOUND,
        'The account was not found.',
        undefined,
        'not-found',
      );
    }
    if (existing.length >= PASSKEY_RULES.maxPerUser) throw limitReached();

    // The label the device shows beside the passkey: the person's own
    // phone number or email, sent only to their own device.
    const shown =
      user.identifiers.find((identifier) => identifier.verifiedAt !== null)
        ?.value ?? user.name;
    const made = await verifier.registrationOptions({
      userId: user.id,
      userName: shown,
      displayName: user.name,
      exclude: existing.map((passkey) => ({
        credentialId: passkey.credentialId,
        transports: passkey.transports,
      })),
    });
    return openCeremony('registration', user.id, made);
  };

  const finishRegistration: Passkeys['finishRegistration'] = async (input) => {
    const challenge = await takeChallenge(
      input.challengeId,
      'registration',
      input.userId,
    );
    // Checking a signature is slow and touches no storage, so it happens
    // outside a unit of work.
    const credential = await verifier.verifyRegistration({
      response: input.response,
      challenge: challenge.challenge,
    });
    if (!credential) throw passkeyInvalid();

    const passkey = await unitOfWork.run(async () => {
      const user = await users.findById(input.userId);
      if (!user || !canSignIn(user)) return null;
      const existing = await passkeys.listForUser(user.id);
      // Checked again here: two registrations may have been started
      // side by side when there was room for one.
      if (existing.length >= PASSKEY_RULES.maxPerUser) throw limitReached();
      const created: Passkey = {
        id: newId(),
        userId: user.id,
        credentialId: credential.credentialId,
        publicKey: credential.publicKey,
        signCount: credential.signCount,
        transports: credential.transports,
        multiDevice: credential.multiDevice,
        backedUp: credential.backedUp,
        name: parsePasskeyName(input.name, `Passkey ${existing.length + 1}`),
        createdAt: nowIso(),
        lastUsedAt: null,
      };
      await passkeys.create(created);
      return created;
    });
    if (!passkey) throw passkeyInvalid();
    return summaryOf(passkey);
  };

  const beginSignIn: Passkeys['beginSignIn'] = async () =>
    openCeremony(
      'authentication',
      null,
      await verifier.authenticationOptions(),
    );

  const finishSignIn: Passkeys['finishSignIn'] = async (input) => {
    const challenge = await takeChallenge(
      input.challengeId,
      'authentication',
      null,
    );
    const credentialId = verifier.credentialIdOf(input.response);
    if (credentialId === null) throw passkeyInvalid();

    const stored = await unitOfWork.run(() =>
      passkeys.findByCredentialId(credentialId),
    );
    if (!stored) throw passkeyInvalid();

    const assertion = await verifier.verifyAuthentication({
      response: input.response,
      challenge: challenge.challenge,
      credential: stored,
    });
    if (!assertion) throw passkeyInvalid();
    // A device may say whose passkey it is. When it does, it must agree
    // with what was stored at registration.
    if (assertion.userId !== null && assertion.userId !== stored.userId) {
      throw passkeyInvalid();
    }

    const tokens = await unitOfWork.run(async () => {
      // Read again, and this time the row stays locked: the count is judged
      // against what is stored now, not what was read before the check.
      const current = await passkeys.findByCredentialId(credentialId);
      if (!current || current.userId !== stored.userId) return null;
      if (judgeSignCount(current.signCount, assertion.signCount) !== 'ok') {
        return null;
      }
      const user = await users.findById(current.userId);
      if (!user || !canSignIn(user)) return null;
      await passkeys.recordUse(current.id, {
        signCount: assertion.signCount,
        backedUp: assertion.backedUp,
        at: nowIso(),
      });
      return startSession(user.id, 'passkey', input.deviceName);
    });
    if (!tokens) throw passkeyInvalid();
    return tokens;
  };

  const listPasskeys: Passkeys['listPasskeys'] = async (input) =>
    (await unitOfWork.run(() => passkeys.listForUser(input.userId))).map(
      summaryOf,
    );

  const renamePasskey: Passkeys['renamePasskey'] = async (input) => {
    const name = parsePasskeyName(input.name, '');
    if (name === '') {
      throw identityFailure(
        IDENTITY_ERRORS.NAME_INVALID,
        'Give the passkey a name.',
      );
    }
    const renamed = await unitOfWork.run(() =>
      passkeys.rename(input.userId, input.passkeyId, name),
    );
    if (!renamed) throw passkeyNotFound();
  };

  const removePasskey: Passkeys['removePasskey'] = async (input) => {
    const removed = await unitOfWork.run(() =>
      passkeys.remove(input.userId, input.passkeyId),
    );
    if (!removed) throw passkeyNotFound();
  };

  return {
    beginRegistration,
    finishRegistration,
    beginSignIn,
    finishSignIn,
    listPasskeys,
    renamePasskey,
    removePasskey,
  };
};
