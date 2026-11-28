import type {
  Identifier,
  OtpChallenge,
  OtpPurpose,
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
