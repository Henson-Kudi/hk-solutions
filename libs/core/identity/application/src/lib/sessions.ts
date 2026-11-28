import type { Messenger } from '@hk/core/comms/application';
import type { Channel } from '@hk/core/comms/domain';
import {
  IDENTITY_ERRORS,
  PASSWORD_RULES,
  canSignIn,
  isAccessLive,
  judgePasswordAttempt,
  judgeRefresh,
  parseDeviceName,
  parseIdentifier,
  sameIdentifier,
  tokenExpiries,
  type Identifier,
  type Session,
  type SessionTokenPair,
  type SignInMethod,
  type User,
} from '@hk/core/identity/domain';
import type { Clock, DomainError } from '@hk/platform/universal';
import {
  createOtpFlow,
  expiredCode,
  identityFailure,
  type CodeSent,
} from './otp-flow';
import type {
  IdentityUnitOfWork,
  OtpCodec,
  OtpRepository,
  PasswordAttemptsRepository,
  PasswordHasher,
  SessionRepository,
  TokenCodec,
  UserRepository,
} from './ports';

/**
 * Sessions: signing in, staying signed in, and signing out.
 *
 * None of these runs offline: a device that is offline keeps working with
 * what it already holds, and talks to the server when it is back.
 */
export const SESSION_USE_CASES = {
  signInWithPassword: {
    name: 'core.identity.sign_in_with_password',
    offline: false,
  },
  requestSignInCode: {
    name: 'core.identity.request_sign_in_code',
    offline: false,
  },
  signInWithCode: { name: 'core.identity.sign_in_with_code', offline: false },
  refresh: { name: 'core.identity.refresh_session', offline: false },
  authenticate: { name: 'core.identity.authenticate', offline: false },
  signOut: { name: 'core.identity.sign_out', offline: false },
  signOutEverywhere: {
    name: 'core.identity.sign_out_everywhere',
    offline: false,
  },
  listSessions: { name: 'core.identity.list_sessions', offline: false },
} as const;

/**
 * What a person holds after signing in or refreshing. The two tokens are
 * secrets: they are returned once, here, and never stored or logged by the
 * server.
 */
export interface SessionTokens {
  userId: string;
  sessionId: string;
  accessToken: string;
  /** ISO 8601 instant after which the access token no longer works. */
  accessExpiresAt: string;
  refreshToken: string;
  /** ISO 8601 instant after which the refresh token no longer works. */
  refreshExpiresAt: string;
}

/** Who a request is from, as established from its access token. */
export interface AuthenticatedSession {
  userId: string;
  sessionId: string;
  method: SignInMethod;
  /** ISO 8601 instant of the sign-in that started the session. */
  signedInAt: string;
  accessExpiresAt: string;
}

/** A session as shown to its owner in a list of devices. */
export interface SessionSummary {
  id: string;
  method: SignInMethod;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string;
  /** True for the session the request came from. */
  current: boolean;
}

export interface SessionsOptions {
  users: UserRepository;
  otps: OtpRepository;
  sessions: SessionRepository;
  passwordAttempts: PasswordAttemptsRepository;
  unitOfWork: IdentityUnitOfWork;
  passwordHasher: PasswordHasher;
  otpCodec: OtpCodec;
  tokenCodec: TokenCodec;
  messenger: Messenger;
  clock: Clock;
  /** Makes ids. A UUID v7 generator in production. */
  newId: () => string;
  /** The product's name as it appears in messages. */
  appName: string;
}

export interface Sessions {
  /**
   * Signs in with a phone number or email and a password. A wrong password,
   * an unknown identifier and an unverified identifier all get the same
   * answer. After ten wrong passwords, password sign-in is locked for an
   * hour; signing in with a code still works.
   */
  signInWithPassword(input: {
    identifier: string;
    password: string;
    deviceName?: string | null;
  }): Promise<SessionTokens>;
  /**
   * Sends a sign-in code. It always answers the same way, whether or not
   * the identifier has an account, and sends a code only when it does.
   */
  requestSignInCode(input: {
    identifier: string;
    channel?: Channel | null;
  }): Promise<CodeSent>;
  /** Signs in with the code sent by requestSignInCode. */
  signInWithCode(input: {
    identifier: string;
    code: string;
    deviceName?: string | null;
  }): Promise<SessionTokens>;
  /**
   * Exchanges a refresh token for a new pair. The old pair stops working.
   * Presenting a refresh token that was already used ends the session,
   * because it may have been stolen.
   */
  refresh(input: { refreshToken: string }): Promise<SessionTokens>;
  /** Establishes who an access token belongs to. The gateway calls this for each request. */
  authenticate(input: { accessToken: string }): Promise<AuthenticatedSession>;
  /** Ends one of the user's own sessions. Does nothing for any other session. */
  signOut(input: { userId: string; sessionId: string }): Promise<void>;
  /**
   * Ends every session of the user, except `exceptSessionId` when given.
   * Returns how many were ended.
   */
  signOutEverywhere(input: {
    userId: string;
    exceptSessionId?: string | null;
  }): Promise<{ ended: number }>;
  /** The user's live sessions, most recently used first. */
  listSessions(input: {
    userId: string;
    currentSessionId?: string | null;
  }): Promise<SessionSummary[]>;
}

const credentialsInvalid = (): DomainError =>
  identityFailure(
    IDENTITY_ERRORS.CREDENTIALS_INVALID,
    'The phone number, email or password is not right.',
  );

const sessionInvalid = (): DomainError =>
  identityFailure(
    IDENTITY_ERRORS.SESSION_INVALID,
    'The session is no longer valid. Sign in again.',
    undefined,
    'forbidden',
  );

/** A token is a string of a plausible length. Anything else is not looked up. */
const looksLikeToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 20 && value.length <= 200;

/** The verified identifier a person may sign in with, or undefined. */
const verifiedHolding = (user: User | null, identifier: Identifier) =>
  user?.identifiers.find(
    (item) => sameIdentifier(item, identifier) && item.verifiedAt !== null,
  );

export const createSessions = (options: SessionsOptions): Sessions => {
  const {
    users,
    sessions,
    passwordAttempts,
    unitOfWork,
    passwordHasher,
    tokenCodec,
    clock,
    newId,
  } = options;
  const { issueCode, pretendSend, redeemCode } = createOtpFlow(options);

  /**
   * A hash of nothing in particular, checked when there is no account or no
   * password to check against. Without it, "no such account" would answer
   * faster than "wrong password", and the difference in time would say
   * which phone numbers have accounts.
   */
  let decoyHash: Promise<string> | undefined;
  const checkAgainstDecoy = async (password: string): Promise<void> => {
    decoyHash ??= passwordHasher.hash('decoy-for-timing-not-a-password');
    await passwordHasher.verify(password, await decoyHash);
  };

  /** A new pair for a session, with the tokens themselves to hand back. */
  const mintPair = (
    session: Session,
    parentId: string | null,
    now: Date,
  ): { pair: SessionTokenPair; tokens: SessionTokens } => {
    const accessToken = tokenCodec.generate('access');
    const refreshToken = tokenCodec.generate('refresh');
    const expiries = tokenExpiries(now);
    return {
      pair: {
        id: newId(),
        sessionId: session.id,
        parentId,
        accessHash: tokenCodec.hash(accessToken),
        refreshHash: tokenCodec.hash(refreshToken),
        issuedAt: now.toISOString(),
        ...expiries,
        rotatedAt: null,
      },
      tokens: {
        userId: session.userId,
        sessionId: session.id,
        accessToken,
        refreshToken,
        ...expiries,
      },
    };
  };

  /** Starts a session. Runs inside the caller's unit of work. */
  const startSession = async (
    userId: string,
    method: SignInMethod,
    deviceName: unknown,
  ): Promise<SessionTokens> => {
    const now = clock.now();
    const session: Session = {
      id: newId(),
      userId,
      method,
      deviceName: parseDeviceName(deviceName),
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      revokedAt: null,
      revokeReason: null,
    };
    const { pair, tokens } = mintPair(session, null, now);
    await sessions.create(session, pair);
    return tokens;
  };

  const signInWithPassword: Sessions['signInWithPassword'] = async (input) => {
    const identifier = parseIdentifier(input.identifier);
    if (!identifier.ok) throw identifier.error;
    // Nothing longer than the longest allowed password can be right, and
    // hashing something huge is work an attacker could ask for at will.
    if (
      typeof input.password !== 'string' ||
      input.password.length > PASSWORD_RULES.maxLength
    ) {
      throw credentialsInvalid();
    }

    const [user, storedHash] = await unitOfWork.run(async () => {
      const found = await users.findByIdentifier(identifier.value);
      return [
        found,
        found ? await users.passwordHashOf(found.id) : null,
      ] as const;
    });
    if (
      !user ||
      !verifiedHolding(user, identifier.value) ||
      storedHash === null
    ) {
      await checkAgainstDecoy(input.password);
      throw credentialsInvalid();
    }

    // The attempt takes its place in the count BEFORE the password is
    // checked, in a unit of work of its own that commits. So ten guesses
    // sent at once are still ten, and the count survives the error below.
    const place = await unitOfWork.run(async () => {
      const verdict = judgePasswordAttempt(
        await passwordAttempts.read(user.id),
        clock.now(),
      );
      if (verdict.allowed) await passwordAttempts.save(user.id, verdict.next);
      return verdict;
    });
    if (!place.allowed) {
      throw identityFailure(
        IDENTITY_ERRORS.ACCOUNT_LOCKED,
        'Too many wrong passwords. Try again later, or sign in with a code.',
        { retryAfterSeconds: place.retryAfterSeconds },
        'forbidden',
      );
    }

    if (!(await passwordHasher.verify(input.password, storedHash))) {
      throw credentialsInvalid();
    }
    // From here the person has proved they know the password, so the
    // answer may say more.
    if (user.status !== 'active') {
      await unitOfWork.run(() => passwordAttempts.clear(user.id));
      throw identityFailure(
        IDENTITY_ERRORS.ACCOUNT_UNAVAILABLE,
        'This account cannot be used. Contact support.',
        undefined,
        'forbidden',
      );
    }

    // The only moment the server holds the password is now, so this is when
    // a hash made with older, weaker settings is replaced.
    const strongerHash = passwordHasher.needsRehash(storedHash)
      ? await passwordHasher.hash(input.password)
      : null;

    return unitOfWork.run(async () => {
      await passwordAttempts.clear(user.id);
      if (strongerHash !== null) {
        await users.setPasswordHash(
          user.id,
          strongerHash,
          clock.now().toISOString(),
        );
      }
      return startSession(user.id, 'password', input.deviceName);
    });
  };

  const requestSignInCode: Sessions['requestSignInCode'] = async (input) => {
    const identifier = parseIdentifier(input.identifier);
    if (!identifier.ok) throw identifier.error;
    const user = await unitOfWork.run(() =>
      users.findByIdentifier(identifier.value),
    );
    if (!user || !canSignIn(user) || !verifiedHolding(user, identifier.value)) {
      return pretendSend(identifier.value, input.channel);
    }
    return issueCode(user, identifier.value, 'login', input.channel);
  };

  const signInWithCode: Sessions['signInWithCode'] = async (input) => {
    const identifier = parseIdentifier(input.identifier);
    if (!identifier.ok) throw identifier.error;
    const user = await unitOfWork.run(() =>
      users.findByIdentifier(identifier.value),
    );
    if (!user || !canSignIn(user) || !verifiedHolding(user, identifier.value)) {
      throw expiredCode();
    }
    let tokens: SessionTokens | undefined;
    // The session starts in the same unit of work that uses the code up:
    // a code can never be spent without a session, nor give two.
    await redeemCode(user, identifier.value, 'login', input.code, async () => {
      tokens = await startSession(user.id, 'otp', input.deviceName);
    });
    if (!tokens) throw expiredCode();
    return tokens;
  };

  const refresh: Sessions['refresh'] = async (input) => {
    if (!looksLikeToken(input.refreshToken)) throw sessionInvalid();
    const refreshHash = tokenCodec.hash(input.refreshToken);

    // The unit of work returns what happened and the error is raised after
    // it commits. Ending a session on reuse must not be rolled back by the
    // very error that reports it.
    const result = await unitOfWork.run(
      async (): Promise<SessionTokens | null> => {
        const found = await sessions.findByRefreshHash(refreshHash);
        if (!found) return null;
        const { pair, session } = found;
        const successor =
          pair.rotatedAt === null
            ? null
            : await sessions.findSuccessor(pair.id);
        const now = clock.now();
        const verdict = judgeRefresh(pair, session, successor, now);

        if (verdict.outcome === 'invalid') return null;
        if (verdict.outcome === 'reuse') {
          await sessions.revoke(
            session.id,
            now.toISOString(),
            'reuse_detected',
          );
          return null;
        }
        // A suspended or deleted person does not get a new pair.
        const user = await users.findById(session.userId);
        if (!user || !canSignIn(user)) return null;

        await sessions.retirePair(
          verdict.outcome === 'retry' ? verdict.replaceId : pair.id,
          now.toISOString(),
        );
        const next = mintPair(session, pair.id, now);
        await sessions.addPair(next.pair);
        await sessions.touch(session.id, now.toISOString());
        return next.tokens;
      },
    );
    if (!result) throw sessionInvalid();
    return result;
  };

  const authenticate: Sessions['authenticate'] = async (input) => {
    if (!looksLikeToken(input.accessToken)) throw sessionInvalid();
    const accessHash = tokenCodec.hash(input.accessToken);
    const result = await unitOfWork.run(async () => {
      const found = await sessions.findByAccessHash(accessHash);
      if (!found) return null;
      if (!isAccessLive(found.pair, found.session, clock.now().toISOString())) {
        return null;
      }
      const user = await users.findById(found.session.userId);
      return user && canSignIn(user) ? found : null;
    });
    if (!result) throw sessionInvalid();
    return {
      userId: result.session.userId,
      sessionId: result.session.id,
      method: result.session.method,
      signedInAt: result.session.createdAt,
      accessExpiresAt: result.pair.accessExpiresAt,
    };
  };

  const signOut: Sessions['signOut'] = async (input) => {
    await unitOfWork.run(async () => {
      const session = await sessions.findById(input.sessionId);
      // Someone else's session is treated like one that does not exist.
      if (!session || session.userId !== input.userId) return;
      await sessions.revoke(
        session.id,
        clock.now().toISOString(),
        'signed_out',
      );
    });
  };

  const signOutEverywhere: Sessions['signOutEverywhere'] = async (input) => ({
    ended: await unitOfWork.run(() =>
      sessions.revokeAllForUser(
        input.userId,
        clock.now().toISOString(),
        'signed_out_everywhere',
        input.exceptSessionId ?? null,
      ),
    ),
  });

  const listSessions: Sessions['listSessions'] = async (input) => {
    const live = await unitOfWork.run(() =>
      sessions.listLiveForUser(input.userId, clock.now().toISOString()),
    );
    return live.map((session) => ({
      id: session.id,
      method: session.method,
      deviceName: session.deviceName,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      current: session.id === (input.currentSessionId ?? null),
    }));
  };

  return {
    signInWithPassword,
    requestSignInCode,
    signInWithCode,
    refresh,
    authenticate,
    signOut,
    signOutEverywhere,
    listSessions,
  };
};
