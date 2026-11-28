import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgSchema,
} from 'drizzle-orm/pg-core';

/**
 * The identity tables: users, what they sign in with, one-time codes,
 * sessions and the count of wrong passwords.
 *
 *   export const identity = identityTables(core);
 *
 * Needs Henson's line-by-line review, like every table definition that
 * becomes a migration.
 *
 * THESE TABLES ARE NOT TENANT-SCOPED, ON PURPOSE. A user is a person, not
 * part of a business: one person can be a member of several businesses and
 * signs in once for all of them. So there are no tenant columns and no
 * row-level security policy here, and each table is listed in
 * IDENTITY_GLOBAL_TABLES for the tenancy schema check to skip. Which
 * businesses a user may enter is decided by memberships, which ARE
 * tenant-scoped.
 *
 * They hold personal data (names, phone numbers, email addresses) and
 * password hashes. Nothing but core/identity reads them.
 */
export const identityTables = (schema: PgSchema) => {
  const users = schema.table(
    'users',
    {
      id: uuid('id').primaryKey(),
      name: text('name').notNull(),
      /** "en", "fr" or "ar". */
      locale: text('locale').notNull(),
      /** "pending", "active", "suspended" or "deleted". */
      status: text('status').notNull(),
      /** An Argon2id hash in PHC form, or null for an account with no password. */
      passwordHash: text('password_hash'),
      passwordChangedAt: timestamp('password_changed_at', {
        withTimezone: true,
        precision: 3,
      }),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      version: integer('version').notNull().default(1),
    },
    (table) => [
      check(
        'users_status',
        sql`${table.status} in ('pending', 'active', 'suspended', 'deleted')`,
      ),
    ],
  );

  const userIdentifiers = schema.table(
    'user_identifiers',
    {
      /** "phone" or "email". */
      kind: text('kind').notNull(),
      /** E.164 for a phone, lower case for an email. */
      value: text('value').notNull(),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      /** When the person proved they hold it. Null until then. */
      verifiedAt: timestamp('verified_at', {
        withTimezone: true,
        precision: 3,
      }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      // One holder per phone number and per email, in the whole system. This
      // is the rule that makes "sign in with your phone number" mean one
      // person.
      primaryKey({
        name: 'user_identifiers_pk',
        columns: [table.kind, table.value],
      }),
      // A user has at most one phone and one email.
      uniqueIndex('user_identifiers_user_kind_uq').on(table.userId, table.kind),
      check('user_identifiers_kind', sql`${table.kind} in ('phone', 'email')`),
    ],
  );

  const otpChallenges = schema.table(
    'otp_challenges',
    {
      id: uuid('id').primaryKey(),
      /**
       * Not a foreign key: a code row outlives a discarded sign-up, so that
       * the resend limits still count it.
       */
      userId: uuid('user_id').notNull(),
      identifierKind: text('identifier_kind').notNull(),
      identifierValue: text('identifier_value').notNull(),
      /** "verify_identifier", "login" or "password_reset". */
      purpose: text('purpose').notNull(),
      /** "sms", "whatsapp" or "email". */
      channel: text('channel').notNull(),
      /** A keyed hash (HMAC-SHA-256) of the code, in hex. Never the code. */
      codeHash: text('code_hash').notNull(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      expiresAt: timestamp('expires_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      /** Wrong attempts so far. */
      attempts: integer('attempts').notNull().default(0),
      /** When it was used or killed. Null while live. */
      consumedAt: timestamp('consumed_at', {
        withTimezone: true,
        precision: 3,
      }),
    },
    (table) => [
      index('otp_challenges_lookup_idx').on(
        table.identifierKind,
        table.identifierValue,
        table.purpose,
        table.createdAt,
      ),
      check('otp_challenges_attempts', sql`${table.attempts} >= 0`),
      check(
        'otp_challenges_kind',
        sql`${table.identifierKind} in ('phone', 'email')`,
      ),
      check(
        'otp_challenges_purpose',
        sql`${table.purpose} in ('verify_identifier', 'login', 'password_reset')`,
      ),
      check(
        'otp_challenges_channel',
        sql`${table.channel} in ('sms', 'whatsapp', 'email')`,
      ),
    ],
  );

  const sessions = schema.table(
    'sessions',
    {
      id: uuid('id').primaryKey(),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      /** "password" or "otp". */
      method: text('method').notNull(),
      /** What the device calls itself. Shown to its owner only; not trusted. */
      deviceName: text('device_name'),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      lastUsedAt: timestamp('last_used_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      revokedAt: timestamp('revoked_at', { withTimezone: true, precision: 3 }),
      /** Why it ended. Set exactly when revoked_at is. */
      revokeReason: text('revoke_reason'),
    },
    (table) => [
      index('sessions_user_idx').on(table.userId, table.lastUsedAt),
      check('sessions_method', sql`${table.method} in ('password', 'otp')`),
      check(
        'sessions_revoke_reason',
        sql`${table.revokeReason} is null or ${table.revokeReason} in ('signed_out', 'signed_out_everywhere', 'password_changed', 'reuse_detected')`,
      ),
      check(
        'sessions_revoked_with_reason',
        sql`(${table.revokedAt} is null) = (${table.revokeReason} is null)`,
      ),
    ],
  );

  const sessionTokenPairs = schema.table(
    'session_token_pairs',
    {
      id: uuid('id').primaryKey(),
      sessionId: uuid('session_id')
        .notNull()
        .references(() => sessions.id, { onDelete: 'cascade' }),
      /** The pair this one replaced. Null for the pair issued at sign-in. */
      parentId: uuid('parent_id'),
      /** SHA-256 of the access token, in hex. Never the token. */
      accessHash: text('access_hash').notNull(),
      /** SHA-256 of the refresh token, in hex. Never the token. */
      refreshHash: text('refresh_hash').notNull(),
      issuedAt: timestamp('issued_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      accessExpiresAt: timestamp('access_expires_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      refreshExpiresAt: timestamp('refresh_expires_at', {
        withTimezone: true,
        precision: 3,
      }).notNull(),
      /** When its refresh token was used, or when it was killed. Null while current. */
      rotatedAt: timestamp('rotated_at', { withTimezone: true, precision: 3 }),
    },
    (table) => [
      // Every request looks a pair up by one of these two.
      uniqueIndex('session_token_pairs_access_uq').on(table.accessHash),
      uniqueIndex('session_token_pairs_refresh_uq').on(table.refreshHash),
      index('session_token_pairs_session_idx').on(table.sessionId),
      index('session_token_pairs_parent_idx').on(table.parentId),
      check(
        'session_token_pairs_distinct_hashes',
        sql`${table.accessHash} <> ${table.refreshHash}`,
      ),
    ],
  );

  const passwordAttempts = schema.table(
    'password_attempts',
    {
      userId: uuid('user_id')
        .primaryKey()
        .references(() => users.id, { onDelete: 'cascade' }),
      /** Password attempts since the last right one. */
      count: integer('count').notNull(),
      lastAttemptAt: timestamp('last_attempt_at', {
        withTimezone: true,
        precision: 3,
      }),
      /** Password sign-in is refused until this moment. Null when not locked. */
      lockedUntil: timestamp('locked_until', {
        withTimezone: true,
        precision: 3,
      }),
    },
    (table) => [check('password_attempts_count', sql`${table.count} >= 0`)],
  );

  return {
    users,
    userIdentifiers,
    otpChallenges,
    sessions,
    sessionTokenPairs,
    passwordAttempts,
  };
};

export type IdentityTables = ReturnType<typeof identityTables>;

/**
 * The identity tables, as "table" names for the tenancy schema check's
 * exempt list: `IDENTITY_GLOBAL_TABLES.map((name) => `${schema}.${name}`)`.
 * Each is global for the reason given above. Do not add a table here to make
 * the check pass; add one only when it truly belongs to no business.
 */
export const IDENTITY_GLOBAL_TABLES = [
  'users',
  'user_identifiers',
  'otp_challenges',
  'sessions',
  'session_token_pairs',
  'password_attempts',
] as const;
