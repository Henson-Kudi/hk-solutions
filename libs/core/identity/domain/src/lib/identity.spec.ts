import type { Result } from '@hk/platform/universal';
import { IDENTITY_ERRORS } from './errors';
import {
  channelsFor,
  maskIdentifier,
  parseEmailIdentifier,
  parseIdentifier,
  parsePhoneIdentifier,
  sameIdentifier,
  type Identifier,
} from './identifier';
import {
  OTP_RULES,
  constantTimeEqual,
  isOtpCode,
  judgeOtp,
  judgeResend,
  otpExpiry,
  type OtpChallenge,
} from './otp';
import {
  PASSWORD_RULES,
  checkPassword,
  findPasswordProblems,
} from './password-policy';
import {
  canSignIn,
  hasVerifiedIdentifier,
  identifierOf,
  nextToVerify,
  parseUserLocale,
  parseUserName,
  statusAfterVerification,
  type User,
  type UserIdentifier,
} from './user';

// Every phone number and address in this file is invented.

const codeOf = (result: Result<unknown>) =>
  result.ok ? null : result.error.code;

const NOW = '2026-11-28T09:00:00.000Z';
const at = (secondsFromNow: number): string =>
  new Date(Date.parse(NOW) + secondsFromNow * 1000).toISOString();

describe('identifiers', () => {
  it.each<[string, Identifier]>([
    ['+237600000001', { kind: 'phone', value: '+237600000001' }],
    ['+237 6 00 00 00 01', { kind: 'phone', value: '+237600000001' }],
    ['+971-50-000-0001', { kind: 'phone', value: '+971500000001' }],
    ['owner@example.com', { kind: 'email', value: 'owner@example.com' }],
    ['  Owner@Example.COM ', { kind: 'email', value: 'owner@example.com' }],
  ])('reads "%s"', (input, expected) => {
    const result = parseIdentifier(input);
    expect(result.ok && result.value).toEqual(expected);
  });

  it.each([
    '',
    '   ',
    '600000001',
    'owner',
    'owner@',
    '@example.com',
    '+237600000001@example',
    'owner@example.com,other@example.com',
  ])('refuses "%s"', (input) => {
    expect(codeOf(parseIdentifier(input))).toBe(
      IDENTITY_ERRORS.IDENTIFIER_INVALID,
    );
  });

  it('refuses anything that is not text', () => {
    for (const input of [undefined, null, 237600000001, {}]) {
      expect(codeOf(parseIdentifier(input))).toBe(
        IDENTITY_ERRORS.IDENTIFIER_INVALID,
      );
    }
  });

  it('does not take a phone number for an email, or the reverse', () => {
    expect(codeOf(parsePhoneIdentifier('owner@example.com'))).toBe(
      IDENTITY_ERRORS.IDENTIFIER_INVALID,
    );
    expect(codeOf(parseEmailIdentifier('+237600000001'))).toBe(
      IDENTITY_ERRORS.IDENTIFIER_INVALID,
    );
  });

  it('treats two spellings of one email address as the same identifier', () => {
    const a = parseIdentifier('Owner@Example.com');
    const b = parseIdentifier('owner@example.COM');
    expect(a.ok && b.ok && sameIdentifier(a.value, b.value)).toBe(true);
  });

  it('treats two ways of writing one phone number as the same identifier', () => {
    const a = parseIdentifier('+237 600 000 001');
    const b = parseIdentifier('+237600000001');
    expect(a.ok && b.ok && sameIdentifier(a.value, b.value)).toBe(true);
  });

  it('keeps a phone number and an email apart', () => {
    expect(
      sameIdentifier(
        { kind: 'phone', value: '+237600000001' },
        { kind: 'email', value: '+237600000001' },
      ),
    ).toBe(false);
  });

  it('never quotes what was typed in its error', () => {
    const result = parseIdentifier('secret.person@@example.com');
    expect(!result.ok && JSON.stringify(result.error.toJSON())).not.toContain(
      'secret',
    );
  });

  it('masks an identifier for display', () => {
    expect(maskIdentifier({ kind: 'phone', value: '+237600000001' })).toBe(
      '+237•••••001',
    );
    expect(maskIdentifier({ kind: 'email', value: 'owner@example.com' })).toBe(
      'o•••@example.com',
    );
  });

  it('knows which channels reach each kind', () => {
    expect(channelsFor('phone')).toEqual(['sms', 'whatsapp']);
    expect(channelsFor('email')).toEqual(['email']);
  });
});

describe('password policy', () => {
  it.each([
    'Sunrise42',
    'Abcdefg1',
    'Motdepasse-Long-2026',
    'Éléphant9bleu',
    `Aa1${'x'.repeat(PASSWORD_RULES.maxLength - 3)}`,
  ])('accepts "%s"', (password) => {
    expect(findPasswordProblems(password)).toEqual([]);
    expect(checkPassword(password).ok).toBe(true);
  });

  it.each<[string, string, string[]]>([
    ['seven characters', 'Abcde1x', ['too_short']],
    ['no upper case', 'sunrise42', ['no_uppercase']],
    ['no lower case', 'SUNRISE42', ['no_lowercase']],
    ['no digit', 'SunriseSun', ['no_digit']],
    ['digits only', '12345678', ['no_uppercase', 'no_lowercase']],
    ['empty', '', ['too_short', 'no_uppercase', 'no_lowercase', 'no_digit']],
    ['a password everybody tries', 'Password123', ['too_common']],
    ['the same in another case', 'PASSWORD123a', []],
    ['a French favourite', 'Azerty123', ['too_common']],
    [
      'longer than the limit',
      `Aa1${'x'.repeat(PASSWORD_RULES.maxLength)}`,
      ['too_long'],
    ],
  ])('finds the problems with %s', (_name, password, expected) => {
    expect(findPasswordProblems(password)).toEqual(expected);
  });

  it('counts characters as a person sees them', () => {
    // Eight characters, though the emoji takes two storage units each.
    expect(findPasswordProblems('Aa1😀😀😀😀😀')).toEqual([]);
  });

  it('refuses a password built from the account’s own details', () => {
    const identity = ['Ada Example', '+237600000001', 'ada@example.com'];
    expect(findPasswordProblems('AdaExample1', { identity })).toEqual([
      'contains_identity',
    ]);
    expect(findPasswordProblems('Aa-237600000001', { identity })).toEqual([
      'contains_identity',
    ]);
    expect(findPasswordProblems('Sunrise42', { identity })).toEqual([]);
  });

  it('does not mind a short fragment that is in many passwords by chance', () => {
    expect(
      findPasswordProblems('Aliment42x', {
        identity: ['Ali', null, undefined],
      }),
    ).toEqual([]);
  });

  it('refuses anything that is not text', () => {
    expect(codeOf(checkPassword(undefined))).toBe(
      IDENTITY_ERRORS.PASSWORD_WEAK,
    );
    expect(codeOf(checkPassword(12345678))).toBe(IDENTITY_ERRORS.PASSWORD_WEAK);
  });

  it('names the broken rules and never repeats the password', () => {
    const result = checkPassword('hunter2secret');
    expect(!result.ok && result.error.details).toEqual({
      problems: 'no_uppercase',
    });
    expect(!result.ok && JSON.stringify(result.error.toJSON())).not.toContain(
      'hunter2',
    );
  });
});

describe('one-time codes', () => {
  const challenge = (overrides: Partial<OtpChallenge> = {}): OtpChallenge => ({
    id: '018f0000-0000-7000-8000-000000000c01',
    userId: '018f0000-0000-7000-8000-0000000000aa',
    identifier: { kind: 'phone', value: '+237600000001' },
    purpose: 'verify_identifier',
    channel: 'sms',
    codeHash: 'a'.repeat(64),
    createdAt: NOW,
    expiresAt: at(OTP_RULES.ttlSeconds),
    attempts: 0,
    consumedAt: null,
    ...overrides,
  });
  const right = 'a'.repeat(64);
  const wrong = 'b'.repeat(64);

  it('follows the rules kept from BizTrack', () => {
    expect(OTP_RULES).toEqual({
      length: 6,
      ttlSeconds: 600,
      maxAttempts: 5,
      resendCooldownSeconds: 60,
      resendWindowSeconds: 600,
      resendMaxPerWindow: 3,
    });
  });

  it('accepts the right code', () => {
    expect(judgeOtp(challenge(), right, at(30))).toEqual({
      outcome: 'accepted',
    });
  });

  it('accepts the right code on the last attempt allowed', () => {
    expect(judgeOtp(challenge({ attempts: 4 }), right, at(30))).toEqual({
      outcome: 'accepted',
    });
  });

  it.each([
    [0, 4],
    [1, 3],
    [2, 2],
    [3, 1],
  ])(
    'after %i wrong attempts, another wrong one leaves %i',
    (attempts, attemptsLeft) => {
      expect(judgeOtp(challenge({ attempts }), wrong, at(30))).toEqual({
        outcome: 'wrong',
        attemptsLeft,
      });
    },
  );

  it('kills the code on the fifth wrong attempt', () => {
    expect(judgeOtp(challenge({ attempts: 4 }), wrong, at(30))).toEqual({
      outcome: 'exhausted',
    });
  });

  it('refuses even the right code once the attempts are used up', () => {
    expect(judgeOtp(challenge({ attempts: 5 }), right, at(30))).toEqual({
      outcome: 'expired',
    });
  });

  it('works until the last second, and not at the moment it expires', () => {
    expect(
      judgeOtp(challenge(), right, at(OTP_RULES.ttlSeconds - 1)).outcome,
    ).toBe('accepted');
    expect(judgeOtp(challenge(), right, at(OTP_RULES.ttlSeconds)).outcome).toBe(
      'expired',
    );
    expect(
      judgeOtp(challenge(), right, at(OTP_RULES.ttlSeconds + 60)).outcome,
    ).toBe('expired');
  });

  it('works once: a used code is refused, right or wrong', () => {
    const used = challenge({ consumedAt: at(10) });
    expect(judgeOtp(used, right, at(20)).outcome).toBe('expired');
    expect(judgeOtp(used, wrong, at(20)).outcome).toBe('expired');
  });

  it('treats a code that does not exist as expired, not as wrong', () => {
    // No attempt can be recorded against nothing, and "wrong" would tell a
    // caller that a code was sent.
    expect(judgeOtp(null, wrong, NOW)).toEqual({ outcome: 'expired' });
  });

  it('does not count a wrong attempt against an expired code', () => {
    expect(
      judgeOtp(challenge({ attempts: 2 }), wrong, at(OTP_RULES.ttlSeconds + 1)),
    ).toEqual({ outcome: 'expired' });
  });

  it('expires a code ten minutes after it is sent', () => {
    expect(otpExpiry(new Date(NOW))).toBe('2026-11-28T09:10:00.000Z');
  });

  it('accepts exactly six digits as a code', () => {
    for (const code of ['000000', '123456', '999999']) {
      expect(isOtpCode(code)).toBe(true);
    }
    for (const code of [
      '12345',
      '1234567',
      '12345a',
      ' 123456',
      '123 456',
      '١٢٣٤٥٦',
      '',
      123456,
      null,
    ]) {
      expect(isOtpCode(code)).toBe(false);
    }
  });

  describe('resending', () => {
    it('allows the first code', () => {
      expect(judgeResend([], NOW)).toEqual({ allowed: true });
    });

    it('makes the person wait a minute between two codes', () => {
      expect(judgeResend([at(-10)], NOW)).toEqual({
        allowed: false,
        reason: 'too_soon',
        retryAfterSeconds: 50,
      });
      expect(judgeResend([at(-59)], NOW)).toEqual({
        allowed: false,
        reason: 'too_soon',
        retryAfterSeconds: 1,
      });
      expect(judgeResend([at(-60)], NOW)).toEqual({ allowed: true });
    });

    it('allows three codes in ten minutes, and not a fourth', () => {
      expect(judgeResend([at(-300), at(-120)], NOW)).toEqual({ allowed: true });
      expect(judgeResend([at(-400), at(-300), at(-120)], NOW)).toEqual({
        allowed: false,
        reason: 'limit',
        // The oldest was sent 400 seconds ago and leaves the window at 600.
        retryAfterSeconds: 200,
      });
    });

    it('forgets codes older than ten minutes', () => {
      expect(judgeResend([at(-900), at(-800), at(-700)], NOW)).toEqual({
        allowed: true,
      });
      expect(judgeResend([at(-601), at(-300), at(-120)], NOW)).toEqual({
        allowed: true,
      });
    });

    it('does not care what order the times are given in', () => {
      expect(judgeResend([at(-120), at(-400), at(-300)], NOW)).toEqual(
        judgeResend([at(-400), at(-300), at(-120)], NOW),
      );
    });

    it('ignores a time in the future, which only a wrong clock produces', () => {
      expect(judgeResend([at(30)], NOW)).toEqual({ allowed: true });
    });
  });

  describe('comparing hashes', () => {
    it('says equal only for the same text', () => {
      expect(constantTimeEqual('abc', 'abc')).toBe(true);
      expect(constantTimeEqual('', '')).toBe(true);
      expect(constantTimeEqual('abc', 'abd')).toBe(false);
      expect(constantTimeEqual('abc', 'ab')).toBe(false);
      expect(constantTimeEqual('ab', 'abc')).toBe(false);
      expect(constantTimeEqual('abc', '')).toBe(false);
      expect(constantTimeEqual('a'.repeat(64), `${'a'.repeat(63)}b`)).toBe(
        false,
      );
    });
  });
});

describe('users', () => {
  const phone: UserIdentifier = {
    kind: 'phone',
    value: '+237600000001',
    verifiedAt: null,
  };
  const email: UserIdentifier = {
    kind: 'email',
    value: 'owner@example.com',
    verifiedAt: null,
  };
  const user = (overrides: Partial<User> = {}): User => ({
    id: '018f0000-0000-7000-8000-0000000000aa',
    name: 'Ada Example',
    locale: 'fr',
    status: 'pending',
    identifiers: [phone, email],
    hasPassword: true,
    createdAt: NOW,
    ...overrides,
  });

  it.each([
    ['Ada Example', 'Ada Example'],
    ['  Ada   Example  ', 'Ada Example'],
    ['Li', 'Li'],
    ['Éloïse N’Diaye', 'Éloïse N’Diaye'],
    ['محمد', 'محمد'],
    ['x'.repeat(60), 'x'.repeat(60)],
  ])('accepts the name "%s"', (input, expected) => {
    const result = parseUserName(input);
    expect(result.ok && result.value).toBe(expected);
  });

  it.each(['', ' ', 'A', 'x'.repeat(61), 'Ada\u0000Example', undefined, 42])(
    'refuses the name %j',
    (input) => {
      expect(codeOf(parseUserName(input))).toBe(IDENTITY_ERRORS.NAME_INVALID);
    },
  );

  it('turns a line break in a name into a space', () => {
    const result = parseUserName('Ada\nExample');
    expect(result.ok && result.value).toBe('Ada Example');
  });

  it('falls back to the default language for one it does not know', () => {
    expect(parseUserLocale('fr')).toBe('fr');
    expect(parseUserLocale('ar')).toBe('ar');
    expect(parseUserLocale('de')).toBe('en');
    expect(parseUserLocale(undefined)).toBe('en');
  });

  it('asks for the phone to be verified first, then the email', () => {
    expect(nextToVerify(user())).toEqual(phone);
    const phoneDone = user({
      identifiers: [{ ...phone, verifiedAt: NOW }, email],
    });
    expect(nextToVerify(phoneDone)).toEqual(email);
    const allDone = user({
      identifiers: [
        { ...phone, verifiedAt: NOW },
        { ...email, verifiedAt: NOW },
      ],
    });
    expect(nextToVerify(allDone)).toBeUndefined();
  });

  it('asks for the email when there is no phone', () => {
    expect(nextToVerify(user({ identifiers: [email] }))).toEqual(email);
  });

  it('finds an identifier by kind', () => {
    expect(identifierOf(user(), 'email')).toEqual(email);
    expect(
      identifierOf(user({ identifiers: [phone] }), 'email'),
    ).toBeUndefined();
  });

  it('lets only an active user with a verified identifier sign in', () => {
    const verified = [{ ...phone, verifiedAt: NOW }];
    expect(canSignIn(user({ status: 'active', identifiers: verified }))).toBe(
      true,
    );
    expect(canSignIn(user({ status: 'pending', identifiers: verified }))).toBe(
      false,
    );
    expect(
      canSignIn(user({ status: 'suspended', identifiers: verified })),
    ).toBe(false);
    expect(canSignIn(user({ status: 'deleted', identifiers: verified }))).toBe(
      false,
    );
    expect(canSignIn(user({ status: 'active' }))).toBe(false);
    expect(hasVerifiedIdentifier(user())).toBe(false);
  });

  it('activates a pending account on verification, and no other', () => {
    expect(statusAfterVerification('pending')).toBe('active');
    expect(statusAfterVerification('active')).toBe('active');
    // Verifying a phone number is not a way back in.
    expect(statusAfterVerification('suspended')).toBe('suspended');
    expect(statusAfterVerification('deleted')).toBe('deleted');
  });
});
