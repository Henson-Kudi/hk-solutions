import {
  IDENTITY_ERRORS,
  type Identifier,
  type OtpChallenge,
} from '@hk/core/identity/domain';
import {
  ConformanceFailure,
  expectEqual,
  expectTrue,
  type ConformanceCase,
} from '@hk/platform/test-kit';
import { isDomainError } from '@hk/platform/universal';
import type { NewUser, OtpRepository, UserRepository } from './ports';

/**
 * What every UserRepository and OtpRepository must do. Each adapter's test
 * file runs these against itself. Every case starts with empty storage.
 */

/** Runs repository calls as the adapter needs them: in a transaction on PostgreSQL. */
type Within = <T>(action: () => Promise<T>) => Promise<T>;

const id = (n: number): string =>
  `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const phone = (n: number): Identifier => ({
  kind: 'phone',
  value: `+2376000000${String(n).padStart(2, '0')}`,
});
const email = (n: number): Identifier => ({
  kind: 'email',
  value: `person${n}@example.com`,
});

const T0 = '2026-11-28T09:00:00.123Z';
const T1 = '2026-11-28T09:05:00.456Z';

const rejectionCode = async (
  action: () => Promise<unknown>,
): Promise<string | undefined> => {
  try {
    await action();
  } catch (error) {
    return isDomainError(error)
      ? error.code
      : `not a DomainError: ${String(error)}`;
  }
  return undefined;
};

// ── UserRepository ──────────────────────────────────────────────────────────

export interface UserRepositorySubject {
  users: UserRepository;
  within: Within;
}

type UserCase = ConformanceCase<UserRepositorySubject>;

const newUser = (n: number, overrides: Partial<NewUser> = {}): NewUser => ({
  id: id(n),
  name: `Person ${n}`,
  locale: 'fr',
  identifiers: [phone(n), email(n)],
  passwordHash: null,
  createdAt: T0,
  ...overrides,
});

export const userRepositoryConformance: readonly UserCase[] = [
  {
    name: 'create adds a pending user with nothing verified, the phone first',
    run: async ({ users, within }) => {
      const created = await within(() =>
        // Given email first, to show the order is the repository's doing.
        users.create(newUser(1, { identifiers: [email(1), phone(1)] })),
      );
      const expected = {
        id: id(1),
        name: 'Person 1',
        locale: 'fr',
        status: 'pending',
        identifiers: [
          { ...phone(1), verifiedAt: null },
          { ...email(1), verifiedAt: null },
        ],
        hasPassword: false,
        createdAt: T0,
      };
      expectEqual(created, expected, 'the created user');
      expectEqual(
        await within(() => users.findById(id(1))),
        expected,
        'found by id',
      );
      expectEqual(
        await within(() => users.findByIdentifier(phone(1))),
        expected,
        'found by phone',
      );
      expectEqual(
        await within(() => users.findByIdentifier(email(1))),
        expected,
        'found by email',
      );
    },
  },
  {
    name: 'a user may have a phone only, or an email only',
    run: async ({ users, within }) => {
      const a = await within(() =>
        users.create(newUser(1, { identifiers: [phone(1)] })),
      );
      const b = await within(() =>
        users.create(newUser(2, { identifiers: [email(2)] })),
      );
      expectEqual(
        a.identifiers,
        [{ ...phone(1), verifiedAt: null }],
        'phone only',
      );
      expectEqual(
        b.identifiers,
        [{ ...email(2), verifiedAt: null }],
        'email only',
      );
    },
  },
  {
    name: 'an unknown id or identifier gives null',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      expectEqual(await within(() => users.findById(id(404))), null, 'by id');
      expectEqual(
        await within(() => users.findByIdentifier(phone(99))),
        null,
        'by phone',
      );
      // The same text as a known phone number, but asked for as an email.
      expectEqual(
        await within(() =>
          users.findByIdentifier({ kind: 'email', value: phone(1).value }),
        ),
        null,
        'a phone value asked for as an email',
      );
    },
  },
  {
    name: 'create refuses an identifier another user holds, verified or not',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      expectEqual(
        await rejectionCode(() =>
          within(() =>
            users.create(newUser(2, { identifiers: [phone(2), email(1)] })),
          ),
        ),
        IDENTITY_ERRORS.IDENTIFIER_TAKEN,
        'an email already held',
      );
      expectEqual(
        await within(() => users.findById(id(2))),
        null,
        'the refused user was not stored',
      );
      expectEqual(
        await within(() => users.findByIdentifier(phone(2))),
        null,
        'nor was its other identifier',
      );
      expectEqual(
        await rejectionCode(() =>
          within(() => users.create(newUser(3, { identifiers: [phone(1)] }))),
        ),
        IDENTITY_ERRORS.IDENTIFIER_TAKEN,
        'a phone already held',
      );
    },
  },
  {
    name: 'verifying an identifier stamps it and makes a pending user active',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      const verified = await within(() =>
        users.markIdentifierVerified(id(1), phone(1), T1),
      );
      expectEqual(verified.status, 'active', 'status');
      expectEqual(
        verified.identifiers,
        [
          { ...phone(1), verifiedAt: T1 },
          { ...email(1), verifiedAt: null },
        ],
        'only the phone is verified',
      );
      expectEqual(
        await within(() => users.findById(id(1))),
        verified,
        'the stored user',
      );
    },
  },
  {
    name: 'verifying again keeps the first time',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      await within(() => users.markIdentifierVerified(id(1), phone(1), T0));
      const again = await within(() =>
        users.markIdentifierVerified(id(1), phone(1), T1),
      );
      expectEqual(again.identifiers[0]?.verifiedAt, T0, 'verifiedAt');
    },
  },
  {
    name: 'verifying an identifier the user does not hold is refused',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      await within(() => users.create(newUser(2)));
      for (const [what, userId, identifier] of [
        ['another user’s phone', id(1), phone(2)],
        ['an unknown user', id(404), phone(1)],
      ] as const) {
        expectEqual(
          await rejectionCode(() =>
            within(() => users.markIdentifierVerified(userId, identifier, T1)),
          ),
          IDENTITY_ERRORS.USER_NOT_FOUND,
          what,
        );
      }
      const other = await within(() => users.findById(id(2)));
      expectEqual(
        other?.identifiers[0]?.verifiedAt,
        null,
        'user 2 is untouched',
      );
    },
  },
  {
    name: 'an unverified identifier can be released, and then taken by another user',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      await within(() => users.markIdentifierVerified(id(1), phone(1), T1));
      await within(() => users.releaseUnverifiedIdentifier(id(1), email(1)));
      const after = await within(() => users.findById(id(1)));
      expectEqual(
        after?.identifiers,
        [{ ...phone(1), verifiedAt: T1 }],
        'the email is gone, the phone stays',
      );
      const taker = await within(() =>
        users.create(newUser(2, { identifiers: [email(1)] })),
      );
      expectEqual(
        taker.identifiers[0]?.value,
        email(1).value,
        'taken by user 2',
      );
    },
  },
  {
    name: 'a verified identifier cannot be released',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      await within(() => users.markIdentifierVerified(id(1), phone(1), T1));
      await within(() => users.releaseUnverifiedIdentifier(id(1), phone(1)));
      await within(() => users.releaseUnverifiedIdentifier(id(404), phone(1)));
      const after = await within(() => users.findByIdentifier(phone(1)));
      expectEqual(after?.id, id(1), 'still held by user 1');
    },
  },
  {
    name: 'a pending user can be discarded, freeing its identifiers',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      await within(() => users.discardPending(id(1)));
      expectEqual(await within(() => users.findById(id(1))), null, 'gone');
      const again = await within(() =>
        users.create(
          newUser(2, {
            identifiers: [phone(1), email(1)],
          }),
        ),
      );
      expectEqual(again.id, id(2), 'the identifiers are free again');
    },
  },
  {
    name: 'a user that is not pending cannot be discarded',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      await within(() => users.markIdentifierVerified(id(1), phone(1), T1));
      await within(() => users.discardPending(id(1)));
      await within(() => users.discardPending(id(404)));
      const still = await within(() => users.findById(id(1)));
      expectEqual(still?.status, 'active', 'the active user is still there');
    },
  },
  {
    name: 'the password hash is kept apart from the user, and can be replaced',
    run: async ({ users, within }) => {
      await within(() => users.create(newUser(1)));
      await within(() =>
        users.create(newUser(2, { passwordHash: 'hash-one' })),
      );
      expectEqual(
        await within(() => users.passwordHashOf(id(1))),
        null,
        'no password set',
      );
      expectEqual(
        await within(() => users.passwordHashOf(id(404))),
        null,
        'an unknown user',
      );
      const withPassword = await within(() => users.findById(id(2)));
      expectEqual(withPassword?.hasPassword, true, 'hasPassword');
      expectEqual(
        await within(() => users.passwordHashOf(id(2))),
        'hash-one',
        'the stored hash',
      );
      expectTrue(
        !JSON.stringify(withPassword).includes('hash-one'),
        'the user object does not carry the hash',
      );

      await within(() => users.setPasswordHash(id(1), 'hash-two', T1));
      expectEqual(
        await within(() => users.passwordHashOf(id(1))),
        'hash-two',
        'after setting',
      );
      const now = await within(() => users.findById(id(1)));
      expectEqual(now?.hasPassword, true, 'hasPassword after setting');
    },
  },
];

// ── OtpRepository ───────────────────────────────────────────────────────────

export interface OtpRepositorySubject {
  otps: OtpRepository;
  within: Within;
}

type OtpCase = ConformanceCase<OtpRepositorySubject>;

const challenge = (
  n: number,
  overrides: Partial<OtpChallenge> = {},
): OtpChallenge => ({
  id: id(0x1000 + n),
  userId: id(1),
  identifier: phone(1),
  purpose: 'verify_identifier',
  channel: 'sms',
  codeHash: `hash-${n}`,
  createdAt: new Date(Date.parse(T0) + n * 60_000).toISOString(),
  expiresAt: new Date(Date.parse(T0) + (n + 10) * 60_000).toISOString(),
  attempts: 0,
  consumedAt: null,
  ...overrides,
});

export const otpRepositoryConformance: readonly OtpCase[] = [
  {
    name: 'a code that was stored is found again, exactly',
    run: async ({ otps, within }) => {
      const stored = challenge(1, {
        identifier: email(3),
        purpose: 'password_reset',
        channel: 'email',
      });
      await within(() => otps.create(stored));
      expectEqual(
        await within(() => otps.findLive(email(3), 'password_reset')),
        stored,
        'the code read back',
      );
    },
  },
  {
    name: 'nothing is found for another identifier or another purpose',
    run: async ({ otps, within }) => {
      await within(() => otps.create(challenge(1)));
      expectEqual(
        await within(() => otps.findLive(phone(2), 'verify_identifier')),
        null,
        'another phone',
      );
      expectEqual(
        await within(() => otps.findLive(phone(1), 'login')),
        null,
        'another purpose',
      );
      expectEqual(
        await within(() =>
          otps.findLive(
            { kind: 'email', value: phone(1).value },
            'verify_identifier',
          ),
        ),
        null,
        'the same text as another kind',
      );
    },
  },
  {
    name: 'the newest live code is the one found',
    run: async ({ otps, within }) => {
      await within(() => otps.create(challenge(1)));
      await within(() => otps.create(challenge(3)));
      await within(() => otps.create(challenge(2)));
      const found = await within(() =>
        otps.findLive(phone(1), 'verify_identifier'),
      );
      expectEqual(found?.id, challenge(3).id, 'the newest');
    },
  },
  {
    name: 'a code past its time is still found: judging time is not the store’s job',
    run: async ({ otps, within }) => {
      const old = challenge(1, {
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:10:00.000Z',
      });
      await within(() => otps.create(old));
      const found = await within(() =>
        otps.findLive(phone(1), 'verify_identifier'),
      );
      expectEqual(found?.id, old.id, 'the expired code');
    },
  },
  {
    name: 'each wrong attempt is counted',
    run: async ({ otps, within }) => {
      await within(() => otps.create(challenge(1)));
      await within(() => otps.recordAttempt(challenge(1).id));
      await within(() => otps.recordAttempt(challenge(1).id));
      const found = await within(() =>
        otps.findLive(phone(1), 'verify_identifier'),
      );
      expectEqual(found?.attempts, 2, 'attempts');
    },
  },
  {
    name: 'a consumed code is no longer live, and the one before it shows',
    run: async ({ otps, within }) => {
      await within(() => otps.create(challenge(1)));
      await within(() => otps.create(challenge(2)));
      await within(() => otps.consume(challenge(2).id, T1));
      const found = await within(() =>
        otps.findLive(phone(1), 'verify_identifier'),
      );
      expectEqual(found?.id, challenge(1).id, 'the earlier live code');
      await within(() => otps.consume(challenge(1).id, T1));
      expectEqual(
        await within(() => otps.findLive(phone(1), 'verify_identifier')),
        null,
        'nothing live is left',
      );
      // Consuming again, or something unknown, is not an error.
      await within(() => otps.consume(challenge(1).id, T1));
      await within(() => otps.consume(id(404), T1));
    },
  },
  {
    name: 'a discarded code is gone: not live, and not counted as sent',
    run: async ({ otps, within }) => {
      await within(() => otps.create(challenge(1)));
      await within(() => otps.create(challenge(2)));
      await within(() => otps.discard(challenge(2).id));
      await within(() => otps.discard(id(404)));
      const found = await within(() =>
        otps.findLive(phone(1), 'verify_identifier'),
      );
      expectEqual(found?.id, challenge(1).id, 'the other code is still live');
      expectEqual(
        await within(() =>
          otps.sentTimes(
            phone(1),
            'verify_identifier',
            '2000-01-01T00:00:00.000Z',
          ),
        ),
        [challenge(1).createdAt],
        'only the other code counts as sent',
      );
    },
  },
  {
    name: 'consumeAll kills every live code of one identifier and purpose, and no other',
    run: async ({ otps, within }) => {
      const otherPurpose = challenge(3, { purpose: 'login' });
      const otherPhone = challenge(4, { identifier: phone(2) });
      await within(() => otps.create(challenge(1)));
      await within(() => otps.create(challenge(2)));
      await within(() => otps.create(otherPurpose));
      await within(() => otps.create(otherPhone));

      await within(() => otps.consumeAll(phone(1), 'verify_identifier', T1));

      expectEqual(
        await within(() => otps.findLive(phone(1), 'verify_identifier')),
        null,
        'the targeted codes are dead',
      );
      const login = await within(() => otps.findLive(phone(1), 'login'));
      expectEqual(login?.id, otherPurpose.id, 'another purpose is untouched');
      const other = await within(() =>
        otps.findLive(phone(2), 'verify_identifier'),
      );
      expectEqual(other?.id, otherPhone.id, 'another phone is untouched');
    },
  },
  {
    name: 'sent times count every code since a moment, used or not',
    run: async ({ otps, within }) => {
      await within(() => otps.create(challenge(1)));
      await within(() => otps.create(challenge(2)));
      await within(() => otps.create(challenge(5)));
      await within(() => otps.create(challenge(3, { purpose: 'login' })));
      await within(() => otps.create(challenge(4, { identifier: phone(2) })));
      await within(() => otps.consume(challenge(2).id, T1));

      const all = await within(() =>
        otps.sentTimes(
          phone(1),
          'verify_identifier',
          '2000-01-01T00:00:00.000Z',
        ),
      );
      expectEqual(
        [...all].sort(),
        [challenge(1), challenge(2), challenge(5)].map((c) => c.createdAt),
        'all three, the consumed one included',
      );
      const recent = await within(() =>
        otps.sentTimes(phone(1), 'verify_identifier', challenge(2).createdAt),
      );
      expectEqual(
        [...recent].sort(),
        [challenge(2), challenge(5)].map((c) => c.createdAt),
        'from a moment on, that moment included',
      );
      if (all.some((time) => typeof time !== 'string')) {
        throw new ConformanceFailure('sent times must be ISO strings');
      }
    },
  },
];
