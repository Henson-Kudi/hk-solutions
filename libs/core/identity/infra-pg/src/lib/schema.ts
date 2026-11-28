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
 * The identity tables: users, what they sign in with, and one-time codes.
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

  return { users, userIdentifiers, otpChallenges };
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
] as const;
