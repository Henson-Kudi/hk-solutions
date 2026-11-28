import type {
  Identifier,
  OtpChallenge,
  OtpPurpose,
  Passkey,
  PasskeyChallenge,
  PasswordAttempts,
  Session,
  SessionRevokeReason,
  SessionTokenPair,
  User,
} from '@hk/core/identity/domain';
import type { Locale } from '@hk/platform/universal';

/**
 * Where users are kept. Every implementation passes
 * userRepositoryConformance. Calls run inside IdentityUnitOfWork.run.
 *
 * A password hash never leaves through a User: it has its own two methods,
 * so code that only needs to know who someone is cannot leak it.
 */
export interface UserRepository {
  /**
   * Adds a user in status "pending", with every identifier unverified.
   * Rejects with IDENTITY_IDENTIFIER_TAKEN when an identifier is already
   * held by any user.
   */
  create(user: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  /** The user holding the identifier, verified or not. */
  findByIdentifier(identifier: Identifier): Promise<User | null>;
  /**
   * Marks the identifier verified at `at`, and makes a pending user active.
   * Rejects with IDENTITY_USER_NOT_FOUND when the user does not hold it.
   */
  markIdentifierVerified(
    userId: string,
    identifier: Identifier,
    at: string,
  ): Promise<User>;
  /**
   * Takes an UNVERIFIED identifier away from a user. Does nothing when the
   * user does not hold it or it is verified.
   */
  releaseUnverifiedIdentifier(
    userId: string,
    identifier: Identifier,
  ): Promise<void>;
  /** Removes a user that is still pending, with its identifiers. Does nothing otherwise. */
  discardPending(userId: string): Promise<void>;
  /** The stored password hash, or null when none is set or the user is unknown. */
  passwordHashOf(userId: string): Promise<string | null>;
  setPasswordHash(userId: string, hash: string, at: string): Promise<void>;
}

export interface NewUser {
  id: string;
  name: string;
  locale: Locale;
  /** One or two: at most one phone and one email. */
  identifiers: readonly Identifier[];
  passwordHash: string | null;
  createdAt: string;
}

/**
 * Where one-time codes are kept. Every implementation passes
 * otpRepositoryConformance. Calls run inside IdentityUnitOfWork.run.
 */
export interface OtpRepository {
  create(challenge: OtpChallenge): Promise<void>;
  /**
   * The newest code for the identifier and purpose that has not been used or
   * killed, or null. It may be expired. On PostgreSQL the row is locked
   * until the unit of work ends, so two attempts cannot be judged at once.
   */
  findLive(
    identifier: Identifier,
    purpose: OtpPurpose,
  ): Promise<OtpChallenge | null>;
  /** When each code for the identifier and purpose was sent, since `since`. */
  sentTimes(
    identifier: Identifier,
    purpose: OtpPurpose,
    since: string,
  ): Promise<string[]>;
  /** Adds one to the wrong-attempt count. */
  recordAttempt(id: string): Promise<void>;
  /** Marks one code used or killed. */
  consume(id: string, at: string): Promise<void>;
  /**
   * Removes a code that was never delivered, as if it had not been made. It
   * then counts neither as sent nor towards the resend limits.
   */
  discard(id: string): Promise<void>;
  /** Kills every live code for the identifier and purpose. */
  consumeAll(
    identifier: Identifier,
    purpose: OtpPurpose,
    at: string,
  ): Promise<void>;
}

/**
 * Runs repository calls as one unit: a database transaction on the server.
 * Identity tables belong to no business, so there is no tenant here.
 *
 * Nothing slow or remote happens inside one: hashing a password and sending
 * a message are done outside.
 */
export interface IdentityUnitOfWork {
  run<T>(action: () => Promise<T>): Promise<T>;
}

/**
 * Hashes passwords with an algorithm made to be slow: Argon2id on the
 * server. The result carries its own parameters and salt.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** False for a wrong password and for a hash it cannot read. Never throws for either. */
  verify(password: string, hash: string): Promise<boolean>;
  /**
   * True when a stored hash was made with weaker settings than today's, or
   * cannot be read. The password is then hashed again at the next sign-in,
   * the only moment the server holds it.
   */
  needsRehash(hash: string): boolean;
}

/** Makes one-time codes and their stored form. */
export interface OtpCodec {
  /** A new six-digit code from a secure random source. */
  generate(): string;
  /**
   * The stored form of a code: a keyed hash, in hex. `binding` ties it to
   * one user, identifier and purpose, so a code cannot be replayed for
   * another. The key is a server secret, so a copy of the table does not
   * reveal the codes.
   */
  hash(code: string, binding: string): string;
}

/** A session and one of its token pairs, found by a token. */
export interface FoundSession {
  session: Session;
  pair: SessionTokenPair;
}

/**
 * Where sessions and their token pairs are kept. Every implementation
 * passes sessionRepositoryConformance. Calls run inside
 * IdentityUnitOfWork.run.
 *
 * Only hashes of tokens are stored and looked up.
 */
export interface SessionRepository {
  /** Stores a new session with its first token pair. */
  create(session: Session, pair: SessionTokenPair): Promise<void>;
  findById(sessionId: string): Promise<Session | null>;
  /**
   * The pair with this refresh token hash, and its session, or null. On
   * PostgreSQL both rows are locked until the unit of work ends, so two
   * uses of one refresh token are judged one after the other.
   */
  findByRefreshHash(refreshHash: string): Promise<FoundSession | null>;
  /** The pair with this access token hash, and its session, or null. Takes no lock. */
  findByAccessHash(accessHash: string): Promise<FoundSession | null>;
  /** The newest pair that replaced the given one, or null. */
  findSuccessor(pairId: string): Promise<SessionTokenPair | null>;
  /** Adds the next pair of a session. */
  addPair(pair: SessionTokenPair): Promise<void>;
  /** Marks a pair used or killed at `at`. Keeps the first time if it already was. */
  retirePair(pairId: string, at: string): Promise<void>;
  /** Records that the session was used at `at`. */
  touch(sessionId: string, at: string): Promise<void>;
  /**
   * Ends a session. True when it was live; false when it is unknown or was
   * already ended, in which case nothing changes.
   */
  revoke(
    sessionId: string,
    at: string,
    reason: SessionRevokeReason,
  ): Promise<boolean>;
  /**
   * Ends every live session of a user, except `exceptSessionId` when given.
   * Returns how many were ended.
   */
  revokeAllForUser(
    userId: string,
    at: string,
    reason: SessionRevokeReason,
    exceptSessionId?: string | null,
  ): Promise<number>;
  /**
   * The user's sessions that can still be used at `now`: not ended, and
   * holding a current pair whose refresh token has not expired. Most
   * recently used first.
   */
  listLiveForUser(userId: string, now: string): Promise<Session[]>;
}

/**
 * Where the count of password attempts is kept, per user. Every
 * implementation passes passwordAttemptsConformance.
 */
export interface PasswordAttemptsRepository {
  /**
   * The count for a user, or NO_PASSWORD_ATTEMPTS when there is none. On
   * PostgreSQL the user's count is locked until the unit of work ends, so
   * attempts arriving together are counted one after the other.
   */
  read(userId: string): Promise<PasswordAttempts>;
  save(userId: string, attempts: PasswordAttempts): Promise<void>;
  /** Forgets the count: after a right password or a password reset. */
  clear(userId: string): Promise<void>;
}

export type TokenKind = 'access' | 'refresh';

/** Makes session tokens and their stored form. */
export interface TokenCodec {
  /** A new token: at least 256 bits from a secure random source. */
  generate(kind: TokenKind): string;
  /**
   * The stored form of a token, in hex. A plain SHA-256 is enough here,
   * unlike for a six-digit code: a token is too long to guess.
   */
  hash(token: string): string;
}

/**
 * Where passkeys are kept. Every implementation passes
 * passkeyRepositoryConformance. Calls run inside IdentityUnitOfWork.run.
 */
export interface PasskeyRepository {
  /**
   * Stores a passkey. Rejects with IDENTITY_PASSKEY_ALREADY_REGISTERED when
   * its credential id is already stored, for any user.
   */
  create(passkey: Passkey): Promise<void>;
  /**
   * The passkey with this credential id, or null. On PostgreSQL the row is
   * locked until the unit of work ends, so two uses of one passkey are
   * judged one after the other.
   */
  findByCredentialId(credentialId: string): Promise<Passkey | null>;
  /** The user's passkeys, oldest first. */
  listForUser(userId: string): Promise<Passkey[]>;
  /** Records a successful sign-in: the count the device reported, and when. */
  recordUse(
    passkeyId: string,
    use: { signCount: number; backedUp: boolean; at: string },
  ): Promise<void>;
  /** Renames one of the user's passkeys. False when the user has no such passkey. */
  rename(userId: string, passkeyId: string, name: string): Promise<boolean>;
  /** Removes one of the user's passkeys. False when the user has no such passkey. */
  remove(userId: string, passkeyId: string): Promise<boolean>;
}

/**
 * Where passkey challenges wait for their answer. Every implementation
 * passes passkeyChallengeConformance.
 */
export interface PasskeyChallengeRepository {
  create(challenge: PasskeyChallenge): Promise<void>;
  /**
   * Removes a challenge and returns it, or null when there is none. A
   * challenge can be taken once: of two takes at the same moment, one gets
   * it and the other gets null.
   */
  take(challengeId: string): Promise<PasskeyChallenge | null>;
}

/** What the server sends a device to start a passkey ceremony. */
export interface PasskeyOptions {
  /** The random value the device must sign, in URL-safe base64. */
  challenge: string;
  /**
   * The options object for the browser or the app, ready to be sent as
   * JSON: what navigator.credentials.create() or .get() is given.
   */
  options: Readonly<Record<string, unknown>>;
}

/** A credential a device has just made, checked and ready to store. */
export interface RegisteredCredential {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[];
  multiDevice: boolean;
  backedUp: boolean;
}

/** What a checked sign-in response says. */
export interface VerifiedAssertion {
  /** The use count the device reported. */
  signCount: number;
  backedUp: boolean;
  /** The user id the device says the passkey is for, or null when it gave none. */
  userId: string | null;
}

/**
 * The WebAuthn part of passkeys: making the options a device needs and
 * checking what it sends back. On the server this wraps a WebAuthn library
 * and is configured with the site's name and the origins it is served
 * from.
 *
 * A response comes from outside and is `unknown` here. The verify methods
 * answer null for anything that does not check out, whatever the reason,
 * and do not throw for it.
 */
export interface PasskeyVerifier {
  registrationOptions(input: {
    userId: string;
    /** Shown by the device next to the passkey: the phone number or email. */
    userName: string;
    displayName: string;
    /** Passkeys the person already has, so a device does not register twice. */
    exclude: readonly Pick<Passkey, 'credentialId' | 'transports'>[];
  }): Promise<PasskeyOptions>;
  /**
   * Checks a registration response: it answers this challenge, was made on
   * one of our origins for our site, and the device verified the person.
   */
  verifyRegistration(input: {
    response: unknown;
    challenge: string;
  }): Promise<RegisteredCredential | null>;
  /** Options for signing in. They name no account: the passkey says whose it is. */
  authenticationOptions(): Promise<PasskeyOptions>;
  /** The credential id a sign-in response claims, unchecked, or null when it has none. */
  credentialIdOf(response: unknown): string | null;
  /**
   * Checks a sign-in response against the stored public key: it answers
   * this challenge, on one of our origins, with a valid signature, and the
   * device verified the person.
   */
  verifyAuthentication(input: {
    response: unknown;
    challenge: string;
    credential: Pick<
      Passkey,
      'credentialId' | 'publicKey' | 'signCount' | 'transports'
    >;
  }): Promise<VerifiedAssertion | null>;
}
