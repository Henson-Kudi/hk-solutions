import {
  IDENTITY_ERRORS,
  NO_PASSWORD_ATTEMPTS,
  sameIdentifier,
  statusAfterVerification,
  type Identifier,
  type OtpChallenge,
  type OtpPurpose,
  type PasswordAttempts,
  type Session,
  type SessionRevokeReason,
  type SessionTokenPair,
  type User,
  type UserIdentifier,
} from '@hk/core/identity/domain';
import { DomainError } from '@hk/platform/universal';
import type {
  FoundSession,
  IdentityUnitOfWork,
  NewUser,
  OtpCodec,
  OtpRepository,
  PasswordAttemptsRepository,
  PasswordHasher,
  SessionRepository,
  TokenCodec,
  UserRepository,
} from './ports';

/** In-memory adapters and test doubles for identity. For tests and local tools. */

interface StoredUser extends User {
  passwordHash: string | null;
}

const order = (identifiers: readonly UserIdentifier[]): UserIdentifier[] =>
  [...identifiers].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === 'phone' ? -1 : 1,
  );

const publicUser = (stored: StoredUser): User => ({
  id: stored.id,
  name: stored.name,
  locale: stored.locale,
  status: stored.status,
  identifiers: order(stored.identifiers),
  hasPassword: stored.passwordHash !== null,
  createdAt: stored.createdAt,
});

const taken = (kind: string): DomainError =>
  new DomainError(
    IDENTITY_ERRORS.IDENTIFIER_TAKEN,
    'An account with this phone number or email already exists.',
    { kind: 'conflict', details: { kind } },
  );

const userNotFound = (): DomainError =>
  new DomainError(
    IDENTITY_ERRORS.USER_NOT_FOUND,
    'The account was not found.',
    { kind: 'not-found' },
  );

export class InMemoryUserRepository implements UserRepository {
  private readonly rows = new Map<string, StoredUser>();

  private holder(identifier: Identifier): StoredUser | undefined {
    for (const row of this.rows.values()) {
      if (row.identifiers.some((item) => sameIdentifier(item, identifier))) {
        return row;
      }
    }
    return undefined;
  }

  async create(user: NewUser): Promise<User> {
    for (const identifier of user.identifiers) {
      if (this.holder(identifier)) throw taken(identifier.kind);
    }
    const stored: StoredUser = {
      id: user.id,
      name: user.name,
      locale: user.locale,
      status: 'pending',
      identifiers: user.identifiers.map((identifier) => ({
        kind: identifier.kind,
        value: identifier.value,
        verifiedAt: null,
      })),
      hasPassword: user.passwordHash !== null,
      passwordHash: user.passwordHash,
      createdAt: user.createdAt,
    };
    this.rows.set(stored.id, stored);
    return publicUser(stored);
  }

  async findById(id: string): Promise<User | null> {
    const row = this.rows.get(id);
    return row ? publicUser(row) : null;
  }

  async findByIdentifier(identifier: Identifier): Promise<User | null> {
    const row = this.holder(identifier);
    return row ? publicUser(row) : null;
  }

  async markIdentifierVerified(
    userId: string,
    identifier: Identifier,
    at: string,
  ): Promise<User> {
    const row = this.rows.get(userId);
    if (
      !row ||
      !row.identifiers.some((item) => sameIdentifier(item, identifier))
    ) {
      throw userNotFound();
    }
    const next: StoredUser = {
      ...row,
      status: statusAfterVerification(row.status),
      identifiers: row.identifiers.map((item) =>
        sameIdentifier(item, identifier)
          ? { ...item, verifiedAt: item.verifiedAt ?? at }
          : item,
      ),
    };
    this.rows.set(userId, next);
    return publicUser(next);
  }

  async releaseUnverifiedIdentifier(
    userId: string,
    identifier: Identifier,
  ): Promise<void> {
    const row = this.rows.get(userId);
    if (!row) return;
    this.rows.set(userId, {
      ...row,
      identifiers: row.identifiers.filter(
        (item) =>
          !(sameIdentifier(item, identifier) && item.verifiedAt === null),
      ),
    });
  }

  async discardPending(userId: string): Promise<void> {
    if (this.rows.get(userId)?.status === 'pending') {
      this.rows.delete(userId);
    }
  }

  async passwordHashOf(userId: string): Promise<string | null> {
    return this.rows.get(userId)?.passwordHash ?? null;
  }

  async setPasswordHash(userId: string, hash: string): Promise<void> {
    const row = this.rows.get(userId);
    if (!row) throw userNotFound();
    this.rows.set(userId, { ...row, passwordHash: hash, hasPassword: true });
  }

  /** A copy of everything held, for the unit of work to restore on failure. */
  snapshot(): Map<string, unknown> {
    return new Map(this.rows);
  }

  restore(snapshot: Map<string, unknown>): void {
    this.rows.clear();
    for (const [key, row] of snapshot) {
      this.rows.set(key, row as StoredUser);
    }
  }

  /** FOR TESTS: sets a user's status, as a platform administrator would. */
  setStatus(userId: string, status: User['status']): void {
    const row = this.rows.get(userId);
    if (row) this.rows.set(userId, { ...row, status });
  }
}

export class InMemoryOtpRepository implements OtpRepository {
  private readonly rows: OtpChallenge[] = [];

  private matches(
    row: OtpChallenge,
    identifier: Identifier,
    purpose: OtpPurpose,
  ): boolean {
    return (
      row.purpose === purpose && sameIdentifier(row.identifier, identifier)
    );
  }

  async create(challenge: OtpChallenge): Promise<void> {
    this.rows.push({ ...challenge });
  }

  async findLive(
    identifier: Identifier,
    purpose: OtpPurpose,
  ): Promise<OtpChallenge | null> {
    const live = this.rows
      .filter(
        (row) =>
          this.matches(row, identifier, purpose) && row.consumedAt === null,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return live[0] ? { ...live[0] } : null;
  }

  async sentTimes(
    identifier: Identifier,
    purpose: OtpPurpose,
    since: string,
  ): Promise<string[]> {
    return this.rows
      .filter(
        (row) =>
          this.matches(row, identifier, purpose) && row.createdAt >= since,
      )
      .map((row) => row.createdAt);
  }

  private replace(
    id: string,
    change: (row: OtpChallenge) => OtpChallenge,
  ): void {
    const index = this.rows.findIndex((row) => row.id === id);
    const row = this.rows[index];
    if (row) this.rows[index] = change(row);
  }

  async recordAttempt(id: string): Promise<void> {
    this.replace(id, (row) => ({ ...row, attempts: row.attempts + 1 }));
  }

  async consume(id: string, at: string): Promise<void> {
    this.replace(id, (row) => ({
      ...row,
      consumedAt: row.consumedAt ?? at,
    }));
  }

  async consumeAll(
    identifier: Identifier,
    purpose: OtpPurpose,
    at: string,
  ): Promise<void> {
    for (const row of [...this.rows]) {
      if (this.matches(row, identifier, purpose) && row.consumedAt === null) {
        this.replace(row.id, (current) => ({ ...current, consumedAt: at }));
      }
    }
  }

  async discard(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }

  /** A copy of everything held, for the unit of work to restore on failure. */
  snapshot(): OtpChallenge[] {
    return this.rows.map((row) => ({ ...row }));
  }

  restore(snapshot: OtpChallenge[]): void {
    this.rows.length = 0;
    this.rows.push(...snapshot.map((row) => ({ ...row })));
  }

  /** FOR TESTS: every code ever stored, oldest first. */
  all(): OtpChallenge[] {
    return this.rows.map((row) => ({ ...row }));
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private sessions = new Map<string, Session>();
  private pairs: SessionTokenPair[] = [];

  private found(pair: SessionTokenPair | undefined): FoundSession | null {
    const session = pair && this.sessions.get(pair.sessionId);
    return pair && session
      ? { pair: { ...pair }, session: { ...session } }
      : null;
  }

  async create(session: Session, pair: SessionTokenPair): Promise<void> {
    this.sessions.set(session.id, { ...session });
    this.pairs.push({ ...pair });
  }

  async findById(sessionId: string): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  async findByRefreshHash(refreshHash: string): Promise<FoundSession | null> {
    return this.found(
      this.pairs.find((pair) => pair.refreshHash === refreshHash),
    );
  }

  async findByAccessHash(accessHash: string): Promise<FoundSession | null> {
    return this.found(
      this.pairs.find((pair) => pair.accessHash === accessHash),
    );
  }

  async findSuccessor(pairId: string): Promise<SessionTokenPair | null> {
    // Pairs are kept in the order they were added, so the last is the newest.
    const children = this.pairs.filter((pair) => pair.parentId === pairId);
    const newest = children[children.length - 1];
    return newest ? { ...newest } : null;
  }

  async addPair(pair: SessionTokenPair): Promise<void> {
    this.pairs.push({ ...pair });
  }

  async retirePair(pairId: string, at: string): Promise<void> {
    this.pairs = this.pairs.map((pair) =>
      pair.id === pairId ? { ...pair, rotatedAt: pair.rotatedAt ?? at } : pair,
    );
  }

  async touch(sessionId: string, at: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, lastUsedAt: at });
  }

  async revoke(
    sessionId: string,
    at: string,
    reason: SessionRevokeReason,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt !== null) return false;
    this.sessions.set(sessionId, {
      ...session,
      revokedAt: at,
      revokeReason: reason,
    });
    return true;
  }

  async revokeAllForUser(
    userId: string,
    at: string,
    reason: SessionRevokeReason,
    exceptSessionId: string | null = null,
  ): Promise<number> {
    let ended = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.userId !== userId || session.id === exceptSessionId) continue;
      if (await this.revoke(session.id, at, reason)) ended += 1;
    }
    return ended;
  }

  async listLiveForUser(userId: string, now: string): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.userId === userId &&
          session.revokedAt === null &&
          this.pairs.some(
            (pair) =>
              pair.sessionId === session.id &&
              pair.rotatedAt === null &&
              pair.refreshExpiresAt > now,
          ),
      )
      .sort((a, b) =>
        a.lastUsedAt === b.lastUsedAt
          ? a.id < b.id
            ? 1
            : -1
          : a.lastUsedAt < b.lastUsedAt
            ? 1
            : -1,
      )
      .map((session) => ({ ...session }));
  }

  /** A copy of everything held, for the unit of work to restore on failure. */
  snapshot(): { sessions: Map<string, Session>; pairs: SessionTokenPair[] } {
    return { sessions: new Map(this.sessions), pairs: [...this.pairs] };
  }

  restore(snapshot: {
    sessions: Map<string, Session>;
    pairs: SessionTokenPair[];
  }): void {
    this.sessions = new Map(snapshot.sessions);
    this.pairs = [...snapshot.pairs];
  }

  /** FOR TESTS: every pair ever stored, oldest first. */
  allPairs(): SessionTokenPair[] {
    return this.pairs.map((pair) => ({ ...pair }));
  }
}

export class InMemoryPasswordAttemptsRepository
  implements PasswordAttemptsRepository
{
  private rows = new Map<string, PasswordAttempts>();

  async read(userId: string): Promise<PasswordAttempts> {
    return { ...(this.rows.get(userId) ?? NO_PASSWORD_ATTEMPTS) };
  }

  async save(userId: string, attempts: PasswordAttempts): Promise<void> {
    this.rows.set(userId, { ...attempts });
  }

  async clear(userId: string): Promise<void> {
    this.rows.delete(userId);
  }

  /** A copy of everything held, for the unit of work to restore on failure. */
  snapshot(): Map<string, PasswordAttempts> {
    return new Map(this.rows);
  }

  restore(snapshot: Map<string, PasswordAttempts>): void {
    this.rows = new Map(snapshot);
  }
}

export interface InMemoryIdentityStore {
  users: InMemoryUserRepository;
  otps: InMemoryOtpRepository;
  sessions: InMemorySessionRepository;
  passwordAttempts: InMemoryPasswordAttemptsRepository;
  unitOfWork: IdentityUnitOfWork;
}

/**
 * In-memory repositories with a unit of work that behaves like a database
 * transaction: when the action throws, everything it changed is undone. A
 * use case that relies on a change surviving an error must therefore make
 * that change in its own unit of work, exactly as on PostgreSQL.
 *
 * It is for one test at a time: it does not isolate units of work running
 * at the same moment.
 */
export const createInMemoryIdentityStore = (): InMemoryIdentityStore => {
  const users = new InMemoryUserRepository();
  const otps = new InMemoryOtpRepository();
  const sessions = new InMemorySessionRepository();
  const passwordAttempts = new InMemoryPasswordAttemptsRepository();
  let depth = 0;
  const unitOfWork: IdentityUnitOfWork = {
    run: async (action) => {
      // A nested call joins the unit of work already open.
      if (depth > 0) return action();
      const before = {
        users: users.snapshot(),
        otps: otps.snapshot(),
        sessions: sessions.snapshot(),
        passwordAttempts: passwordAttempts.snapshot(),
      };
      depth += 1;
      try {
        return await action();
      } catch (error) {
        users.restore(before.users);
        otps.restore(before.otps);
        sessions.restore(before.sessions);
        passwordAttempts.restore(before.passwordAttempts);
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
  return { users, otps, sessions, passwordAttempts, unitOfWork };
};

/**
 * A stand-in password hasher, FOR TESTS ONLY. It is instant and reversible:
 * the "hash" contains the password. Production uses Argon2id.
 *
 * A hash written as `test-old-hash:<password>` also verifies, and is the
 * one it reports as needing a rehash: a stand-in for a hash made with
 * settings that have since been raised.
 */
export const insecureTestPasswordHasher: PasswordHasher = {
  hash: async (password) => `test-hash:${password}`,
  verify: async (password, hash) =>
    hash === `test-hash:${password}` || hash === `test-old-hash:${password}`,
  needsRehash: (hash) => !hash.startsWith('test-hash:'),
};

/**
 * A stand-in code maker, FOR TESTS ONLY. Codes come from a fixed list, then
 * count up, so a test knows what was "sent". The hash is not secret.
 */
export const createTestOtpCodec = (
  codes: readonly string[] = [],
): OtpCodec & { issued: string[] } => {
  const issued: string[] = [];
  let counter = 100000;
  return {
    issued,
    generate: () => {
      const code = codes[issued.length] ?? String((counter += 1));
      issued.push(code);
      return code;
    },
    hash: (code, binding) => `test-otp:${binding}:${code}`,
  };
};

/**
 * A stand-in token maker, FOR TESTS ONLY. Tokens count up, so a test can
 * tell them apart and predict them. The "hash" is the token backwards.
 */
export const createTestTokenCodec = (): TokenCodec & { issued: string[] } => {
  const issued: string[] = [];
  return {
    issued,
    generate: (kind) => {
      const token = `test-${kind}-token-${String(issued.length + 1).padStart(4, '0')}`;
      issued.push(token);
      return token;
    },
    // Reversed, so a test can check that the token itself is not stored.
    hash: (token) => `hashed:${Array.from(token).reverse().join('')}`,
  };
};
