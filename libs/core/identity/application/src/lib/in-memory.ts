import {
  IDENTITY_ERRORS,
  sameIdentifier,
  statusAfterVerification,
  type Identifier,
  type OtpChallenge,
  type OtpPurpose,
  type User,
  type UserIdentifier,
} from '@hk/core/identity/domain';
import { DomainError } from '@hk/platform/universal';
import type {
  IdentityUnitOfWork,
  NewUser,
  OtpCodec,
  OtpRepository,
  PasswordHasher,
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

export interface InMemoryIdentityStore {
  users: InMemoryUserRepository;
  otps: InMemoryOtpRepository;
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
  let depth = 0;
  const unitOfWork: IdentityUnitOfWork = {
    run: async (action) => {
      // A nested call joins the unit of work already open.
      if (depth > 0) return action();
      const before = { users: users.snapshot(), otps: otps.snapshot() };
      depth += 1;
      try {
        return await action();
      } catch (error) {
        users.restore(before.users);
        otps.restore(before.otps);
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
  return { users, otps, unitOfWork };
};

/**
 * A stand-in password hasher, FOR TESTS ONLY. It is instant and reversible:
 * the "hash" contains the password. Production uses Argon2id.
 */
export const insecureTestPasswordHasher: PasswordHasher = {
  hash: async (password) => `test-hash:${password}`,
  verify: async (password, hash) => hash === `test-hash:${password}`,
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
