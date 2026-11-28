import type {
  IdentityUnitOfWork,
  NewUser,
  OtpRepository,
  UserRepository,
} from '@hk/core/identity/application';
import type { Channel } from '@hk/core/comms/domain';
import {
  IDENTITY_ERRORS,
  parseUserLocale,
  statusAfterVerification,
  type Identifier,
  type IdentifierKind,
  type OtpChallenge,
  type OtpPurpose,
  type User,
  type UserStatus,
} from '@hk/core/identity/domain';
import {
  requireSystemTransaction,
  withSystemTransaction,
  type Database,
} from '@hk/platform/db';
import { DomainError } from '@hk/platform/universal';
import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm';
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

/** The unit of work on PostgreSQL: one transaction, with no tenant. */
export const createPgIdentityUnitOfWork = (
  database: Database,
): IdentityUnitOfWork => ({
  run: (action) => withSystemTransaction(database, action),
});
