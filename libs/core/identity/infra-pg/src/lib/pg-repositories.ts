import type {
  FoundSession,
  IdentityUnitOfWork,
  NewUser,
  OtpRepository,
  PasswordAttemptsRepository,
  SessionRepository,
  UserRepository,
} from '@hk/core/identity/application';
import type { Channel } from '@hk/core/comms/domain';
import {
  IDENTITY_ERRORS,
  NO_PASSWORD_ATTEMPTS,
  parseUserLocale,
  statusAfterVerification,
  type Identifier,
  type IdentifierKind,
  type OtpChallenge,
  type OtpPurpose,
  type PasswordAttempts,
  type Session,
  type SessionRevokeReason,
  type SessionTokenPair,
  type SignInMethod,
  type User,
  type UserStatus,
} from '@hk/core/identity/domain';
import {
  requireSystemTransaction,
  withSystemTransaction,
  type Database,
} from '@hk/platform/db';
import { DomainError } from '@hk/platform/universal';
import { and, asc, desc, eq, gt, gte, isNull, ne, sql } from 'drizzle-orm';
import type { IdentityTables } from './schema';

/**
 * Identity repositories on PostgreSQL. Every method runs inside
 * withSystemTransaction (see createPgIdentityUnitOfWork): the identity
 * tables belong to no business, so there is no tenant transaction here.
 */

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

export class PgUserRepository implements UserRepository {
  constructor(private readonly tables: IdentityTables) {}

  private async load(userId: string): Promise<User | null> {
    const { users, userIdentifiers } = this.tables;
    const transaction = requireSystemTransaction();
    const rows = await transaction
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const identifiers = await transaction
      .select()
      .from(userIdentifiers)
      .where(eq(userIdentifiers.userId, userId))
      // "phone" sorts after "email", so descending puts the phone first.
      .orderBy(desc(userIdentifiers.kind));
    return {
      id: row.id,
      name: row.name,
      locale: parseUserLocale(row.locale),
      status: row.status as UserStatus,
      identifiers: identifiers.map((item) => ({
        kind: item.kind as IdentifierKind,
        value: item.value,
        verifiedAt: item.verifiedAt ? item.verifiedAt.toISOString() : null,
      })),
      hasPassword: row.passwordHash !== null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async holderId(identifier: Identifier): Promise<string | null> {
    const { userIdentifiers } = this.tables;
    const rows = await requireSystemTransaction()
      .select({ userId: userIdentifiers.userId })
      .from(userIdentifiers)
      .where(
        and(
          eq(userIdentifiers.kind, identifier.kind),
          eq(userIdentifiers.value, identifier.value),
        ),
      )
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  async create(user: NewUser): Promise<User> {
    const { users, userIdentifiers } = this.tables;
    const transaction = requireSystemTransaction();
    // Checked first for a clear error. The primary key on (kind, value) is
    // what actually guarantees it when two sign-ups race.
    for (const identifier of user.identifiers) {
      if (await this.holderId(identifier)) throw taken(identifier.kind);
    }
    await transaction.insert(users).values({
      id: user.id,
      name: user.name,
      locale: user.locale,
      status: 'pending',
      passwordHash: user.passwordHash,
      passwordChangedAt:
        user.passwordHash === null ? null : new Date(user.createdAt),
      createdAt: new Date(user.createdAt),
    });
    await transaction
      .insert(userIdentifiers)
      .values(
        user.identifiers.map((identifier) => ({
          kind: identifier.kind,
          value: identifier.value,
          userId: user.id,
        })),
      )
      .onConflictDoNothing();
    const created = await this.load(user.id);
    // A racing sign-up took an identifier between the check and the insert.
    if (!created || created.identifiers.length !== user.identifiers.length) {
      throw taken(user.identifiers[0]?.kind ?? 'phone');
    }
    return created;
  }

  findById(id: string): Promise<User | null> {
    return this.load(id);
  }

  async findByIdentifier(identifier: Identifier): Promise<User | null> {
    const userId = await this.holderId(identifier);
    return userId ? this.load(userId) : null;
  }

  async markIdentifierVerified(
    userId: string,
    identifier: Identifier,
    at: string,
  ): Promise<User> {
    const { users, userIdentifiers } = this.tables;
    const transaction = requireSystemTransaction();
    const held = await transaction
      .update(userIdentifiers)
      .set({
        // Keeps the first time when it is verified again.
        verifiedAt: sql`coalesce(${userIdentifiers.verifiedAt}, ${at}::timestamptz)`,
      })
      .where(
        and(
          eq(userIdentifiers.userId, userId),
          eq(userIdentifiers.kind, identifier.kind),
          eq(userIdentifiers.value, identifier.value),
        ),
      )
      .returning({ userId: userIdentifiers.userId });
    if (held.length === 0) throw userNotFound();

    const current = await this.load(userId);
    if (!current) throw userNotFound();
    const status = statusAfterVerification(current.status);
    if (status !== current.status) {
      await transaction
        .update(users)
        .set({
          status,
          version: sql`${users.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));
    }
    return { ...current, status };
  }

  async releaseUnverifiedIdentifier(
    userId: string,
    identifier: Identifier,
  ): Promise<void> {
    const { userIdentifiers } = this.tables;
    await requireSystemTransaction()
      .delete(userIdentifiers)
      .where(
        and(
          eq(userIdentifiers.userId, userId),
          eq(userIdentifiers.kind, identifier.kind),
          eq(userIdentifiers.value, identifier.value),
          isNull(userIdentifiers.verifiedAt),
        ),
      );
  }

  async discardPending(userId: string): Promise<void> {
    const { users } = this.tables;
    // The identifiers go with the user (ON DELETE CASCADE).
    await requireSystemTransaction()
      .delete(users)
      .where(and(eq(users.id, userId), eq(users.status, 'pending')));
  }

  async passwordHashOf(userId: string): Promise<string | null> {
    const { users } = this.tables;
    const rows = await requireSystemTransaction()
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.passwordHash ?? null;
  }

  async setPasswordHash(
    userId: string,
    hash: string,
    at: string,
  ): Promise<void> {
    const { users } = this.tables;
    const rows = await requireSystemTransaction()
      .update(users)
      .set({
        passwordHash: hash,
        passwordChangedAt: new Date(at),
        version: sql`${users.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (rows.length === 0) throw userNotFound();
  }
}

export class PgOtpRepository implements OtpRepository {
  constructor(private readonly tables: IdentityTables) {}

  private match(identifier: Identifier, purpose: OtpPurpose) {
    const { otpChallenges } = this.tables;
    return and(
      eq(otpChallenges.identifierKind, identifier.kind),
      eq(otpChallenges.identifierValue, identifier.value),
      eq(otpChallenges.purpose, purpose),
    );
  }

  async create(challenge: OtpChallenge): Promise<void> {
    await requireSystemTransaction()
      .insert(this.tables.otpChallenges)
      .values({
        id: challenge.id,
        userId: challenge.userId,
        identifierKind: challenge.identifier.kind,
        identifierValue: challenge.identifier.value,
        purpose: challenge.purpose,
        channel: challenge.channel,
        codeHash: challenge.codeHash,
        createdAt: new Date(challenge.createdAt),
        expiresAt: new Date(challenge.expiresAt),
        attempts: challenge.attempts,
        consumedAt:
          challenge.consumedAt === null ? null : new Date(challenge.consumedAt),
      });
  }

  async findLive(
    identifier: Identifier,
    purpose: OtpPurpose,
  ): Promise<OtpChallenge | null> {
    const { otpChallenges } = this.tables;
    const rows = await requireSystemTransaction()
      .select()
      .from(otpChallenges)
      .where(
        and(this.match(identifier, purpose), isNull(otpChallenges.consumedAt)),
      )
      .orderBy(desc(otpChallenges.createdAt), desc(otpChallenges.id))
      .limit(1)
      // Locked until the transaction ends: two attempts at the same code are
      // judged one after the other, so neither can slip past the limit.
      .for('update');
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      identifier: {
        kind: row.identifierKind as IdentifierKind,
        value: row.identifierValue,
      },
      purpose: row.purpose as OtpPurpose,
      channel: row.channel as Channel,
      codeHash: row.codeHash,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      attempts: row.attempts,
      consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
    };
  }

  async sentTimes(
    identifier: Identifier,
    purpose: OtpPurpose,
    since: string,
  ): Promise<string[]> {
    const { otpChallenges } = this.tables;
    const rows = await requireSystemTransaction()
      .select({ createdAt: otpChallenges.createdAt })
      .from(otpChallenges)
      .where(
        and(
          this.match(identifier, purpose),
          gte(otpChallenges.createdAt, new Date(since)),
        ),
      )
      .orderBy(asc(otpChallenges.createdAt));
    return rows.map((row) => row.createdAt.toISOString());
  }

  async recordAttempt(id: string): Promise<void> {
    const { otpChallenges } = this.tables;
    await requireSystemTransaction()
      .update(otpChallenges)
      .set({ attempts: sql`${otpChallenges.attempts} + 1` })
      .where(eq(otpChallenges.id, id));
  }

  async consume(id: string, at: string): Promise<void> {
    const { otpChallenges } = this.tables;
    await requireSystemTransaction()
      .update(otpChallenges)
      .set({ consumedAt: new Date(at) })
      .where(and(eq(otpChallenges.id, id), isNull(otpChallenges.consumedAt)));
  }

  async discard(id: string): Promise<void> {
    const { otpChallenges } = this.tables;
    await requireSystemTransaction()
      .delete(otpChallenges)
      .where(eq(otpChallenges.id, id));
  }

  async consumeAll(
    identifier: Identifier,
    purpose: OtpPurpose,
    at: string,
  ): Promise<void> {
    const { otpChallenges } = this.tables;
    await requireSystemTransaction()
      .update(otpChallenges)
      .set({ consumedAt: new Date(at) })
      .where(
        and(this.match(identifier, purpose), isNull(otpChallenges.consumedAt)),
      );
  }
}

const iso = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly tables: IdentityTables) {}

  private toSession(row: IdentityTables['sessions']['$inferSelect']): Session {
    return {
      id: row.id,
      userId: row.userId,
      method: row.method as SignInMethod,
      deviceName: row.deviceName,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      revokedAt: iso(row.revokedAt),
      revokeReason: row.revokeReason as SessionRevokeReason | null,
    };
  }

  private toPair(
    row: IdentityTables['sessionTokenPairs']['$inferSelect'],
  ): SessionTokenPair {
    return {
      id: row.id,
      sessionId: row.sessionId,
      parentId: row.parentId,
      accessHash: row.accessHash,
      refreshHash: row.refreshHash,
      issuedAt: row.issuedAt.toISOString(),
      accessExpiresAt: row.accessExpiresAt.toISOString(),
      refreshExpiresAt: row.refreshExpiresAt.toISOString(),
      rotatedAt: iso(row.rotatedAt),
    };
  }

  private pairValues(pair: SessionTokenPair) {
    return {
      id: pair.id,
      sessionId: pair.sessionId,
      parentId: pair.parentId,
      accessHash: pair.accessHash,
      refreshHash: pair.refreshHash,
      issuedAt: new Date(pair.issuedAt),
      accessExpiresAt: new Date(pair.accessExpiresAt),
      refreshExpiresAt: new Date(pair.refreshExpiresAt),
      rotatedAt: pair.rotatedAt === null ? null : new Date(pair.rotatedAt),
    };
  }

  async create(session: Session, pair: SessionTokenPair): Promise<void> {
    const transaction = requireSystemTransaction();
    await transaction.insert(this.tables.sessions).values({
      id: session.id,
      userId: session.userId,
      method: session.method,
      deviceName: session.deviceName,
      createdAt: new Date(session.createdAt),
      lastUsedAt: new Date(session.lastUsedAt),
      revokedAt:
        session.revokedAt === null ? null : new Date(session.revokedAt),
      revokeReason: session.revokeReason,
    });
    await transaction
      .insert(this.tables.sessionTokenPairs)
      .values(this.pairValues(pair));
  }

  async findById(sessionId: string): Promise<Session | null> {
    const { sessions } = this.tables;
    const rows = await requireSystemTransaction()
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return rows[0] ? this.toSession(rows[0]) : null;
  }

  async findByRefreshHash(refreshHash: string): Promise<FoundSession | null> {
    const { sessions, sessionTokenPairs } = this.tables;
    const rows = await requireSystemTransaction()
      .select({ pair: sessionTokenPairs, session: sessions })
      .from(sessionTokenPairs)
      .innerJoin(sessions, eq(sessions.id, sessionTokenPairs.sessionId))
      .where(eq(sessionTokenPairs.refreshHash, refreshHash))
      .limit(1)
      // Both rows are locked until the transaction ends. Two uses of one
      // refresh token therefore run one after the other, and the second
      // sees what the first did.
      .for('update');
    const row = rows[0];
    return row
      ? { pair: this.toPair(row.pair), session: this.toSession(row.session) }
      : null;
  }

  async findByAccessHash(accessHash: string): Promise<FoundSession | null> {
    const { sessions, sessionTokenPairs } = this.tables;
    const rows = await requireSystemTransaction()
      .select({ pair: sessionTokenPairs, session: sessions })
      .from(sessionTokenPairs)
      .innerJoin(sessions, eq(sessions.id, sessionTokenPairs.sessionId))
      .where(eq(sessionTokenPairs.accessHash, accessHash))
      .limit(1);
    const row = rows[0];
    return row
      ? { pair: this.toPair(row.pair), session: this.toSession(row.session) }
      : null;
  }

  async findSuccessor(pairId: string): Promise<SessionTokenPair | null> {
    const { sessionTokenPairs } = this.tables;
    const rows = await requireSystemTransaction()
      .select()
      .from(sessionTokenPairs)
      .where(eq(sessionTokenPairs.parentId, pairId))
      .orderBy(desc(sessionTokenPairs.issuedAt), desc(sessionTokenPairs.id))
      .limit(1);
    return rows[0] ? this.toPair(rows[0]) : null;
  }

  async addPair(pair: SessionTokenPair): Promise<void> {
    await requireSystemTransaction()
      .insert(this.tables.sessionTokenPairs)
      .values(this.pairValues(pair));
  }

  async retirePair(pairId: string, at: string): Promise<void> {
    const { sessionTokenPairs } = this.tables;
    await requireSystemTransaction()
      .update(sessionTokenPairs)
      .set({
        rotatedAt: sql`coalesce(${sessionTokenPairs.rotatedAt}, ${at}::timestamptz)`,
      })
      .where(eq(sessionTokenPairs.id, pairId));
  }

  async touch(sessionId: string, at: string): Promise<void> {
    const { sessions } = this.tables;
    await requireSystemTransaction()
      .update(sessions)
      .set({ lastUsedAt: new Date(at) })
      .where(eq(sessions.id, sessionId));
  }

  async revoke(
    sessionId: string,
    at: string,
    reason: SessionRevokeReason,
  ): Promise<boolean> {
    const { sessions } = this.tables;
    const rows = await requireSystemTransaction()
      .update(sessions)
      .set({ revokedAt: new Date(at), revokeReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  async revokeAllForUser(
    userId: string,
    at: string,
    reason: SessionRevokeReason,
    exceptSessionId: string | null = null,
  ): Promise<number> {
    const { sessions } = this.tables;
    const rows = await requireSystemTransaction()
      .update(sessions)
      .set({ revokedAt: new Date(at), revokeReason: reason })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptSessionId === null
            ? undefined
            : ne(sessions.id, exceptSessionId),
        ),
      )
      .returning({ id: sessions.id });
    return rows.length;
  }

  async listLiveForUser(userId: string, now: string): Promise<Session[]> {
    const { sessions, sessionTokenPairs } = this.tables;
    const transaction = requireSystemTransaction();
    const usable = transaction
      .select({ one: sql`1` })
      .from(sessionTokenPairs)
      .where(
        and(
          eq(sessionTokenPairs.sessionId, sessions.id),
          isNull(sessionTokenPairs.rotatedAt),
          gt(sessionTokenPairs.refreshExpiresAt, new Date(now)),
        ),
      );
    const rows = await transaction
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          sql`exists (${usable})`,
        ),
      )
      .orderBy(desc(sessions.lastUsedAt), desc(sessions.id));
    return rows.map((row) => this.toSession(row));
  }
}

export class PgPasswordAttemptsRepository
  implements PasswordAttemptsRepository
{
  constructor(private readonly tables: IdentityTables) {}

  async read(userId: string): Promise<PasswordAttempts> {
    const { passwordAttempts } = this.tables;
    const transaction = requireSystemTransaction();
    // There may be no row to lock yet, so the lock is on the user's id
    // itself. It is held until the transaction ends: attempts that arrive
    // together are counted one after the other.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'identity:password-attempts:' + userId}, 0))`,
    );
    const rows = await transaction
      .select()
      .from(passwordAttempts)
      .where(eq(passwordAttempts.userId, userId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          count: row.count,
          lastAttemptAt: iso(row.lastAttemptAt),
          lockedUntil: iso(row.lockedUntil),
        }
      : { ...NO_PASSWORD_ATTEMPTS };
  }

  async save(userId: string, attempts: PasswordAttempts): Promise<void> {
    const { passwordAttempts } = this.tables;
    const values = {
      count: attempts.count,
      lastAttemptAt:
        attempts.lastAttemptAt === null
          ? null
          : new Date(attempts.lastAttemptAt),
      lockedUntil:
        attempts.lockedUntil === null ? null : new Date(attempts.lockedUntil),
    };
    await requireSystemTransaction()
      .insert(passwordAttempts)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: passwordAttempts.userId, set: values });
  }

  async clear(userId: string): Promise<void> {
    const { passwordAttempts } = this.tables;
    await requireSystemTransaction()
      .delete(passwordAttempts)
      .where(eq(passwordAttempts.userId, userId));
  }
}

/** The unit of work on PostgreSQL: one transaction, with no tenant. */
export const createPgIdentityUnitOfWork = (
  database: Database,
): IdentityUnitOfWork => ({
  run: (action) => withSystemTransaction(database, action),
});
