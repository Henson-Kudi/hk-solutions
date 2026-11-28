import {
  createFakeEmailSender,
  createFakeSmsSender,
  createFakeWhatsAppSender,
  createMessenger,
  type FakeSender,
} from '@hk/core/comms/application';
import {
  smsLength,
  validateMessage,
  type EmailMessage,
  type SmsMessage,
  type WhatsAppMessage,
} from '@hk/core/comms/domain';
import {
  IDENTITY_ERRORS,
  OTP_PURPOSES,
  type Identifier,
} from '@hk/core/identity/domain';
import { sequentialIds } from '@hk/platform/test-kit';
import { FixedClock, isDomainError } from '@hk/platform/universal';
import {
  ACCOUNT_USE_CASES,
  createAccounts,
  type Accounts,
  type SignUpInput,
} from './accounts';
import {
  otpRepositoryConformance,
  userRepositoryConformance,
} from './conformance';
import {
  InMemoryOtpRepository,
  InMemoryUserRepository,
  createInMemoryIdentityStore,
  createTestOtpCodec,
  insecureTestPasswordHasher,
  type InMemoryIdentityStore,
} from './in-memory';
import { OTP_WHATSAPP_TEMPLATES, otpMessage } from './otp-messages';

// Every phone number, address and password in this file is invented.

const PHONE = '+237600000001';
const EMAIL = 'ada@example.com';
const PASSWORD = 'Sunrise42-blue'; // gitleaks:allow (made up for the tests)
const START = '2026-11-28T09:00:00.000Z';

const phoneId: Identifier = { kind: 'phone', value: PHONE };
const emailId: Identifier = { kind: 'email', value: EMAIL };

const failure = async (action: () => Promise<unknown>) => {
  try {
    await action();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('nothing was thrown');
};

const codeOf = async (action: () => Promise<unknown>): Promise<string> =>
  (await failure(action)).code;

describe('accounts', () => {
  let store: InMemoryIdentityStore;
  let clock: FixedClock;
  let codec: ReturnType<typeof createTestOtpCodec>;
  let sms: FakeSender<SmsMessage>;
  let whatsapp: FakeSender<WhatsAppMessage>;
  let mail: FakeSender<EmailMessage>;
  let accounts: Accounts;

  /** Moves the clock forward. */
  const wait = (seconds: number): void => {
    clock.set(new Date(clock.now().getTime() + seconds * 1000));
  };
  /** The code most recently made. */
  const lastCode = (): string =>
    codec.issued[codec.issued.length - 1] as string;

  const signUp = (overrides: Partial<SignUpInput> = {}) =>
    accounts.signUp({
      name: 'Ada Example',
      phone: PHONE,
      email: EMAIL,
      password: PASSWORD,
      locale: 'en',
      ...overrides,
    });

  /** Signs up with a phone only and verifies it: an active account. */
  const activeAccount = async (
    overrides: Partial<SignUpInput> = {},
  ): Promise<string> => {
    const { userId } = await signUp({ email: null, ...overrides });
    await accounts.verifyCode({
      identifier: overrides.phone ?? PHONE,
      code: lastCode(),
    });
    return userId;
  };

  beforeEach(() => {
    store = createInMemoryIdentityStore();
    clock = new FixedClock(START);
    codec = createTestOtpCodec();
    sms = createFakeSmsSender(clock);
    whatsapp = createFakeWhatsAppSender(clock);
    mail = createFakeEmailSender(clock);
    accounts = createAccounts({
      users: store.users,
      otps: store.otps,
      sessions: store.sessions,
      passwordAttempts: store.passwordAttempts,
      unitOfWork: store.unitOfWork,
      passwordHasher: insecureTestPasswordHasher,
      otpCodec: codec,
      messenger: createMessenger({ sms, whatsapp, email: mail }),
      clock,
      newId: sequentialIds(9),
      appName: 'HK',
    });
  });

  it('declares that no account use case runs offline', () => {
    for (const useCase of Object.values(ACCOUNT_USE_CASES)) {
      expect(useCase.offline).toBe(false);
      expect(useCase.name).toMatch(/^core\.identity\.[a-z_]+$/);
    }
    expect(Object.keys(ACCOUNT_USE_CASES)).toHaveLength(6);
  });

  describe('sign-up', () => {
    it('creates a pending account and sends a code to the phone by SMS', async () => {
      const result = await signUp();
      expect(result.codeSent).toEqual({
        kind: 'phone',
        destination: '+237•••••001',
        channel: 'sms',
        expiresAt: '2026-11-28T09:10:00.000Z',
      });
      const user = await store.users.findById(result.userId);
      expect(user).toMatchObject({
        name: 'Ada Example',
        locale: 'en',
        status: 'pending',
        hasPassword: true,
        identifiers: [
          { kind: 'phone', value: PHONE, verifiedAt: null },
          { kind: 'email', value: EMAIL, verifiedAt: null },
        ],
      });
      expect(sms.sent).toEqual([
        {
          channel: 'sms',
          to: PHONE,
          text: `HK: your verification code is ${lastCode()}. Valid for 10 minutes. Do not share it.`,
          sensitive: true,
        },
      ]);
      expect(mail.sent).toEqual([]);
    });

    it('writes the message in the person’s language', async () => {
      await signUp({ locale: 'fr' });
      expect(sms.last()?.text).toBe(
        `HK : votre code de vérification est ${lastCode()}. Valable 10 minutes. Ne le partagez pas.`,
      );
    });

    it('sends by WhatsApp when the person prefers it', async () => {
      const result = await signUp({ preferredChannel: 'whatsapp' });
      expect(result.codeSent.channel).toBe('whatsapp');
      expect(whatsapp.sent).toEqual([
        {
          channel: 'whatsapp',
          to: PHONE,
          template: 'otp_verification',
          language: 'en',
          parameters: [lastCode()],
          sensitive: true,
        },
      ]);
      expect(sms.sent).toEqual([]);
    });

    it('sends to the email when there is no phone', async () => {
      const result = await signUp({ phone: null });
      expect(result.codeSent).toMatchObject({
        kind: 'email',
        destination: 'a•••@example.com',
        channel: 'email',
      });
      expect(mail.last()?.subject).toBe('HK: your verification code');
      expect(mail.last()?.text).toContain(lastCode());
      expect(mail.last()?.sensitive).toBe(true);
    });

    it('ignores a preferred channel that cannot reach the identifier', async () => {
      const result = await signUp({ phone: null, preferredChannel: 'sms' });
      expect(result.codeSent.channel).toBe('email');
    });

    it('normalises the phone number and the email', async () => {
      const { userId } = await signUp({
        phone: '+237 600 000 001',
        email: ' Ada@Example.COM ',
      });
      const user = await store.users.findById(userId);
      expect(user?.identifiers.map((item) => item.value)).toEqual([
        PHONE,
        EMAIL,
      ]);
    });

    it('stores a hash of the password, never the password', async () => {
      const { userId } = await signUp();
      expect(await store.users.passwordHashOf(userId)).toBe(
        `test-hash:${PASSWORD}`,
      );
      expect(JSON.stringify(await store.users.findById(userId))).not.toContain(
        PASSWORD,
      );
    });

    it('allows an account with no password', async () => {
      const { userId } = await signUp({ password: null });
      expect((await store.users.findById(userId))?.hasPassword).toBe(false);
    });

    it('stores a hash of the code, never the code', async () => {
      await signUp();
      const [stored] = store.otps.all();
      expect(stored?.codeHash).not.toBe(lastCode());
      expect(stored?.codeHash).toContain('test-otp:');
      expect(stored).toMatchObject({
        purpose: 'verify_identifier',
        channel: 'sms',
        attempts: 0,
        consumedAt: null,
        createdAt: START,
        expiresAt: '2026-11-28T09:10:00.000Z',
      });
    });

    it.each<[string, Partial<SignUpInput>, string]>([
      [
        'no phone and no email',
        { phone: null, email: null },
        IDENTITY_ERRORS.IDENTIFIER_REQUIRED,
      ],
      [
        'a phone with no country code',
        { phone: '600000001' },
        IDENTITY_ERRORS.IDENTIFIER_INVALID,
      ],
      [
        'a malformed email',
        { email: 'ada@' },
        IDENTITY_ERRORS.IDENTIFIER_INVALID,
      ],
      ['a one-letter name', { name: 'A' }, IDENTITY_ERRORS.NAME_INVALID],
      ['a weak password', { password: 'short' }, IDENTITY_ERRORS.PASSWORD_WEAK],
      [
        'a password built from the name',
        { password: 'AdaExample1' },
        IDENTITY_ERRORS.PASSWORD_WEAK,
      ],
      [
        'a password built from the phone number',
        { password: 'Aa-237600000001' },
        IDENTITY_ERRORS.PASSWORD_WEAK,
      ],
    ])('refuses %s, and creates nothing', async (_name, overrides, code) => {
      expect(await codeOf(() => signUp(overrides))).toBe(code);
      expect(await store.users.findByIdentifier(phoneId)).toBeNull();
      expect(sms.sent).toEqual([]);
    });

    it('says so when the phone number already has a verified account', async () => {
      await activeAccount();
      wait(120);
      const error = await failure(() =>
        signUp({ name: 'Someone Else', email: 'else@example.com' }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.IDENTIFIER_TAKEN);
      expect(error.kind).toBe('conflict');
      expect(error.details).toEqual({ kind: 'phone' });
      expect(sms.sent).toHaveLength(1);
      expect(
        await store.users.findByIdentifier({
          kind: 'email',
          value: 'else@example.com',
        }),
      ).toBeNull();
    });

    it('clears away an abandoned sign-up that used the same phone', async () => {
      const first = await signUp({ name: 'Typo Name' });
      wait(61);
      const second = await signUp({ name: 'Ada Example' });
      expect(second.userId).not.toBe(first.userId);
      expect(await store.users.findById(first.userId)).toBeNull();
      expect((await store.users.findByIdentifier(phoneId))?.name).toBe(
        'Ada Example',
      );
    });

    it('does not let an abandoned sign-up’s code verify the new account', async () => {
      await signUp();
      const oldCode = lastCode();
      wait(61);
      await signUp();
      expect(
        await codeOf(() =>
          accounts.verifyCode({ identifier: PHONE, code: oldCode }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_INVALID);
    });

    it('releases an email another account typed but never verified', async () => {
      // The first account verified its phone, not its email.
      const first = await signUp();
      await accounts.verifyCode({ identifier: PHONE, code: lastCode() });
      wait(61);
      const second = await signUp({
        name: 'Real Owner',
        phone: '+237600000002',
      });
      expect(
        (await store.users.findById(first.userId))?.identifiers.map(
          (item) => item.kind,
        ),
      ).toEqual(['phone']);
      expect((await store.users.findByIdentifier(emailId))?.id).toBe(
        second.userId,
      );
    });

    it('falls back to WhatsApp when the SMS provider is down', async () => {
      sms.failNext('unavailable');
      const result = await signUp();
      expect(result.codeSent.channel).toBe('whatsapp');
      expect(whatsapp.last()?.parameters).toEqual([lastCode()]);
    });

    it('tries the next channel after a timeout: a second copy of a code is harmless', async () => {
      sms.failNext('timeout');
      const result = await signUp();
      expect(result.codeSent.channel).toBe('whatsapp');
    });

    it('fails when no channel can deliver, and leaves no usable code', async () => {
      sms.failNext('unavailable');
      whatsapp.failNext('rejected');
      const error = await failure(() => signUp());
      expect(error.code).toBe(IDENTITY_ERRORS.OTP_DELIVERY_FAILED);
      expect(error.details).toEqual({ attempts: 2 });
      expect(store.otps.all()).toEqual([]);
    });

    it('lets the person try again at once after a failed delivery', async () => {
      sms.failNext('unavailable');
      whatsapp.failNext('unavailable');
      await failure(() => signUp());
      // No waiting: nothing was delivered, so nothing counts as sent.
      const result = await signUp();
      expect(result.codeSent.channel).toBe('sms');
    });
  });

  describe('verifying a code', () => {
    it('verifies the phone, activates the account, then asks for the email', async () => {
      const { userId } = await signUp();
      const result = await accounts.verifyCode({
        identifier: PHONE,
        code: lastCode(),
      });
      expect(result).toEqual({
        userId,
        complete: false,
        codeSent: {
          kind: 'email',
          destination: 'a•••@example.com',
          channel: 'email',
          expiresAt: '2026-11-28T09:10:00.000Z',
        },
      });
      const user = await store.users.findById(userId);
      expect(user?.status).toBe('active');
      expect(user?.identifiers[0]?.verifiedAt).toBe(START);
      expect(user?.identifiers[1]?.verifiedAt).toBeNull();
      expect(mail.last()?.text).toContain(lastCode());
    });

    it('is complete once the email is verified too', async () => {
      const { userId } = await signUp();
      await accounts.verifyCode({ identifier: PHONE, code: lastCode() });
      const result = await accounts.verifyCode({
        identifier: EMAIL,
        code: lastCode(),
      });
      expect(result).toEqual({ userId, complete: true, codeSent: null });
      const user = await store.users.findById(userId);
      expect(user?.identifiers.every((item) => item.verifiedAt !== null)).toBe(
        true,
      );
    });

    it('is complete at once for an account with a phone only', async () => {
      await signUp({ email: null });
      const result = await accounts.verifyCode({
        identifier: PHONE,
        code: lastCode(),
      });
      expect(result.complete).toBe(true);
      expect(result.codeSent).toBeNull();
    });

    it('accepts the identifier however it is written', async () => {
      await signUp({ email: null });
      const result = await accounts.verifyCode({
        identifier: '+237 600-000-001',
        code: lastCode(),
      });
      expect(result.complete).toBe(true);
    });

    it('works once', async () => {
      await signUp({ email: null });
      const code = lastCode();
      await accounts.verifyCode({ identifier: PHONE, code });
      expect(
        await codeOf(() => accounts.verifyCode({ identifier: PHONE, code })),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
    });

    it('says how many attempts are left after a wrong code', async () => {
      await signUp();
      const error = await failure(() =>
        accounts.verifyCode({ identifier: PHONE, code: '000000' }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.OTP_INVALID);
      expect(error.details).toEqual({ attemptsLeft: 4 });
    });

    it('keeps the count of wrong attempts although each attempt fails', async () => {
      // The store rolls back whatever a failed unit of work changed, as a
      // database does. The count must survive that.
      await signUp();
      await failure(() =>
        accounts.verifyCode({ identifier: PHONE, code: '000000' }),
      );
      await failure(() =>
        accounts.verifyCode({ identifier: PHONE, code: '000000' }),
      );
      expect(store.otps.all()[0]?.attempts).toBe(2);
    });

    it('kills the code on the fifth wrong attempt, and then refuses the right one', async () => {
      await signUp();
      const code = lastCode();
      const outcomes: string[] = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        outcomes.push(
          await codeOf(() =>
            accounts.verifyCode({ identifier: PHONE, code: '000000' }),
          ),
        );
      }
      expect(outcomes).toEqual([
        IDENTITY_ERRORS.OTP_INVALID,
        IDENTITY_ERRORS.OTP_INVALID,
        IDENTITY_ERRORS.OTP_INVALID,
        IDENTITY_ERRORS.OTP_INVALID,
        IDENTITY_ERRORS.OTP_MAX_ATTEMPTS,
      ]);
      expect(
        await codeOf(() => accounts.verifyCode({ identifier: PHONE, code })),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
      expect((await store.users.findByIdentifier(phoneId))?.status).toBe(
        'pending',
      );
    });

    it('accepts the right code on the fifth attempt', async () => {
      await signUp({ email: null });
      const code = lastCode();
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await failure(() =>
          accounts.verifyCode({ identifier: PHONE, code: '000000' }),
        );
      }
      expect(
        (await accounts.verifyCode({ identifier: PHONE, code })).complete,
      ).toBe(true);
    });

    it('refuses a code after ten minutes, and not a second before', async () => {
      await signUp({ email: null });
      const code = lastCode();
      wait(600);
      expect(
        await codeOf(() => accounts.verifyCode({ identifier: PHONE, code })),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
      // The expired code is not counted as a wrong attempt.
      expect(store.otps.all()[0]?.attempts).toBe(0);
    });

    it('still accepts a code one second before it expires', async () => {
      await signUp({ email: null });
      const code = lastCode();
      wait(599);
      expect(
        (await accounts.verifyCode({ identifier: PHONE, code })).complete,
      ).toBe(true);
    });

    it.each(['12345', '1234567', 'abcdef', '', '12 345', '１２３４５６'])(
      'refuses "%s" as not a code, without using an attempt',
      async (code) => {
        await signUp();
        expect(
          await codeOf(() => accounts.verifyCode({ identifier: PHONE, code })),
        ).toBe(IDENTITY_ERRORS.OTP_INVALID);
        expect(store.otps.all()[0]?.attempts).toBe(0);
      },
    );

    it('answers an unknown identifier like a dead code', async () => {
      expect(
        await codeOf(() =>
          accounts.verifyCode({ identifier: '+237600000099', code: '123456' }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
    });

    it('does not let the phone’s code verify the email', async () => {
      await signUp();
      const phoneCode = lastCode();
      expect(
        await codeOf(() =>
          accounts.verifyCode({ identifier: EMAIL, code: phoneCode }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
    });

    it('does not reactivate a suspended account', async () => {
      const { userId } = await signUp();
      store.users.setStatus(userId, 'suspended');
      await accounts.verifyCode({ identifier: PHONE, code: lastCode() });
      expect((await store.users.findById(userId))?.status).toBe('suspended');
    });
  });

  describe('resending a code', () => {
    it('sends a new code after a minute, and the old one stops working', async () => {
      await signUp({ email: null });
      const first = lastCode();
      wait(60);
      const sent = await accounts.resendCode({ identifier: PHONE });
      expect(sent).toMatchObject({ kind: 'phone', channel: 'sms' });
      expect(lastCode()).not.toBe(first);
      expect(sms.sent).toHaveLength(2);
      expect(
        await codeOf(() =>
          accounts.verifyCode({ identifier: PHONE, code: first }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_INVALID);
      expect(
        (await accounts.verifyCode({ identifier: PHONE, code: lastCode() }))
          .complete,
      ).toBe(true);
    });

    it('can switch to WhatsApp when the SMS did not arrive', async () => {
      await signUp();
      wait(60);
      const sent = await accounts.resendCode({
        identifier: PHONE,
        channel: 'whatsapp',
      });
      expect(sent.channel).toBe('whatsapp');
      expect(whatsapp.sent).toHaveLength(1);
    });

    it('makes the person wait a minute', async () => {
      await signUp();
      wait(20);
      const error = await failure(() =>
        accounts.resendCode({ identifier: PHONE }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.OTP_RESEND_TOO_SOON);
      expect(error.details).toEqual({ retryAfterSeconds: 40 });
      expect(sms.sent).toHaveLength(1);
    });

    it('keeps the first code working when a resend is refused', async () => {
      await signUp({ email: null });
      const code = lastCode();
      wait(20);
      await failure(() => accounts.resendCode({ identifier: PHONE }));
      expect(
        (await accounts.verifyCode({ identifier: PHONE, code })).complete,
      ).toBe(true);
    });

    it('allows three codes in ten minutes, and not a fourth', async () => {
      await signUp();
      wait(100);
      await accounts.resendCode({ identifier: PHONE });
      wait(100);
      await accounts.resendCode({ identifier: PHONE });
      wait(100);
      const error = await failure(() =>
        accounts.resendCode({ identifier: PHONE }),
      );
      expect(error.code).toBe(IDENTITY_ERRORS.OTP_RESEND_LIMIT);
      // The first code was sent 300 seconds ago and leaves the window at 600.
      expect(error.details).toEqual({ retryAfterSeconds: 300 });
      expect(sms.sent).toHaveLength(3);

      wait(300);
      await accounts.resendCode({ identifier: PHONE });
      expect(sms.sent).toHaveLength(4);
    });

    it('counts the phone and the email separately', async () => {
      await signUp();
      await accounts.verifyCode({ identifier: PHONE, code: lastCode() });
      // The email's first code was just sent; the phone's limits do not apply to it.
      wait(60);
      const sent = await accounts.resendCode({ identifier: EMAIL });
      expect(sent.kind).toBe('email');
      expect(mail.sent).toHaveLength(2);
    });

    it('answers the same way for an identifier with no account, and sends nothing', async () => {
      const sent = await accounts.resendCode({ identifier: '+237600000099' });
      expect(sent).toEqual({
        kind: 'phone',
        destination: '+237•••••099',
        channel: 'sms',
        expiresAt: '2026-11-28T09:10:00.000Z',
      });
      expect(sms.sent).toEqual([]);
      expect(store.otps.all()).toEqual([]);
    });

    it('sends nothing for an identifier that is already verified', async () => {
      await activeAccount();
      wait(120);
      const sent = await accounts.resendCode({ identifier: PHONE });
      expect(Object.keys(sent).sort()).toEqual([
        'channel',
        'destination',
        'expiresAt',
        'kind',
      ]);
      expect(sms.sent).toHaveLength(1);
    });
  });

  describe('resetting a forgotten password', () => {
    it('sends a reset code, and sets the new password with it', async () => {
      const userId = await activeAccount();
      wait(120);
      const sent = await accounts.requestPasswordReset({ identifier: PHONE });
      expect(sent).toMatchObject({ kind: 'phone', channel: 'sms' });
      expect(sms.last()?.text).toContain('password reset code');
      expect(store.otps.all().at(-1)?.purpose).toBe('password_reset');

      const result = await accounts.resetPassword({
        identifier: PHONE,
        code: lastCode(),
        newPassword: 'Brand-new-Pass9',
      });
      expect(result).toEqual({ userId });
      expect(await store.users.passwordHashOf(userId)).toBe(
        'test-hash:Brand-new-Pass9',
      );
    });

    it('gives an account that had no password its first one', async () => {
      const userId = await activeAccount({ password: null });
      wait(120);
      await accounts.requestPasswordReset({ identifier: PHONE });
      await accounts.resetPassword({
        identifier: PHONE,
        code: lastCode(),
        newPassword: 'Brand-new-Pass9',
      });
      expect((await store.users.findById(userId))?.hasPassword).toBe(true);
    });

    it.each<[string, () => Promise<void> | void]>([
      ['an identifier with no account', () => undefined],
      [
        'an account that never verified',
        async () => {
          await signUp();
        },
      ],
      [
        'a suspended account',
        async () => {
          const userId = await activeAccount();
          store.users.setStatus(userId, 'suspended');
        },
      ],
    ])(
      'answers the same way for %s, and sends nothing',
      async (_name, arrange) => {
        await arrange();
        wait(120);
        const before = sms.sent.length;
        const sent = await accounts.requestPasswordReset({ identifier: PHONE });
        expect(sent).toEqual({
          kind: 'phone',
          destination: '+237•••••001',
          channel: 'sms',
          expiresAt: new Date(clock.now().getTime() + 600_000).toISOString(),
        });
        expect(sms.sent).toHaveLength(before);
        expect(
          store.otps.all().some((code) => code.purpose === 'password_reset'),
        ).toBe(false);
      },
    );

    it('gives a real request and a pretend one answers of the same shape', async () => {
      await activeAccount();
      wait(120);
      const real = await accounts.requestPasswordReset({ identifier: PHONE });
      const pretend = await accounts.requestPasswordReset({
        identifier: '+237600000099',
      });
      expect(Object.keys(real).sort()).toEqual(Object.keys(pretend).sort());
      expect(real.channel).toBe(pretend.channel);
      expect(real.expiresAt).toBe(pretend.expiresAt);
    });

    it('does not use up the code on a weak new password', async () => {
      const userId = await activeAccount();
      wait(120);
      await accounts.requestPasswordReset({ identifier: PHONE });
      const code = lastCode();
      expect(
        await codeOf(() =>
          accounts.resetPassword({
            identifier: PHONE,
            code,
            newPassword: 'weak',
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSWORD_WEAK);
      await accounts.resetPassword({
        identifier: PHONE,
        code,
        newPassword: 'Brand-new-Pass9',
      });
      expect(await store.users.passwordHashOf(userId)).toBe(
        'test-hash:Brand-new-Pass9',
      );
    });

    it('works once, and counts wrong codes', async () => {
      const userId = await activeAccount();
      wait(120);
      await accounts.requestPasswordReset({ identifier: PHONE });
      const code = lastCode();
      const wrong = await failure(() =>
        accounts.resetPassword({
          identifier: PHONE,
          code: '000000',
          newPassword: 'Brand-new-Pass9',
        }),
      );
      expect(wrong.code).toBe(IDENTITY_ERRORS.OTP_INVALID);
      expect(wrong.details).toEqual({ attemptsLeft: 4 });
      // The password did not change on the wrong code.
      expect(await store.users.passwordHashOf(userId)).toBe(
        `test-hash:${PASSWORD}`,
      );

      await accounts.resetPassword({
        identifier: PHONE,
        code,
        newPassword: 'Brand-new-Pass9',
      });
      expect(
        await codeOf(() =>
          accounts.resetPassword({
            identifier: PHONE,
            code,
            newPassword: 'Another-Pass10',
          }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
    });

    it('does not accept a verification code as a reset code', async () => {
      await signUp();
      await accounts.verifyCode({ identifier: PHONE, code: lastCode() });
      // The email's verification code is live. It must not reset a password.
      const emailCode = lastCode();
      expect(
        await codeOf(() =>
          accounts.resetPassword({
            identifier: EMAIL,
            code: emailCode,
            newPassword: 'Brand-new-Pass9',
          }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
    });

    it('answers a reset for an unknown identifier like a dead code', async () => {
      expect(
        await codeOf(() =>
          accounts.resetPassword({
            identifier: '+237600000099',
            code: '123456',
            newPassword: 'Brand-new-Pass9',
          }),
        ),
      ).toBe(IDENTITY_ERRORS.OTP_EXPIRED);
    });
  });

  describe('changing a password', () => {
    it('changes it when the current one is right', async () => {
      const userId = await activeAccount();
      await accounts.changePassword({
        userId,
        currentPassword: PASSWORD,
        newPassword: 'Brand-new-Pass9',
      });
      expect(await store.users.passwordHashOf(userId)).toBe(
        'test-hash:Brand-new-Pass9',
      );
    });

    it.each([
      ['a wrong password', 'Wrong-Pass-77'],
      ['none', null],
    ])(
      'refuses when the current password given is %s',
      async (_name, currentPassword) => {
        const userId = await activeAccount();
        expect(
          await codeOf(() =>
            accounts.changePassword({
              userId,
              currentPassword,
              newPassword: 'Brand-new-Pass9',
            }),
          ),
        ).toBe(IDENTITY_ERRORS.CREDENTIALS_INVALID);
        expect(await store.users.passwordHashOf(userId)).toBe(
          `test-hash:${PASSWORD}`,
        );
      },
    );

    it('lets an account with no password set its first without one', async () => {
      const userId = await activeAccount({ password: null });
      await accounts.changePassword({
        userId,
        currentPassword: null,
        newPassword: 'Brand-new-Pass9',
      });
      expect((await store.users.findById(userId))?.hasPassword).toBe(true);
    });

    it('applies the password rules to the new one', async () => {
      const userId = await activeAccount();
      expect(
        await codeOf(() =>
          accounts.changePassword({
            userId,
            currentPassword: PASSWORD,
            newPassword: 'adaexample1',
          }),
        ),
      ).toBe(IDENTITY_ERRORS.PASSWORD_WEAK);
    });

    it('does not find an unknown, pending or suspended account', async () => {
      const pending = await signUp();
      const attempt = (userId: string) =>
        codeOf(() =>
          accounts.changePassword({
            userId,
            currentPassword: PASSWORD,
            newPassword: 'Brand-new-Pass9',
          }),
        );
      expect(await attempt('018f0000-0000-7000-8000-000000000404')).toBe(
        IDENTITY_ERRORS.USER_NOT_FOUND,
      );
      expect(await attempt(pending.userId)).toBe(
        IDENTITY_ERRORS.USER_NOT_FOUND,
      );
      store.users.setStatus(pending.userId, 'suspended');
      expect(await attempt(pending.userId)).toBe(
        IDENTITY_ERRORS.USER_NOT_FOUND,
      );
    });
  });

  describe('privacy', () => {
    it('never puts a phone number, an email, a code or a password in an error', async () => {
      await signUp();
      const code = lastCode();
      const errors = [
        await failure(() => signUp({ phone: '+237600000001999999' })),
        await failure(() => signUp({ email: 'ada.secret@@example.com' })),
        await failure(() =>
          signUp({ phone: '+237600000002', password: 'weakpw' }),
        ),
        await failure(() =>
          accounts.verifyCode({ identifier: PHONE, code: '000000' }),
        ),
        await failure(() => accounts.resendCode({ identifier: PHONE })),
        await failure(() =>
          accounts.verifyCode({ identifier: '+237600000099', code }),
        ),
      ];
      wait(120);
      await accounts.verifyCode({ identifier: PHONE, code });
      errors.push(
        await failure(() =>
          signUp({ name: 'Someone Else', email: 'else@example.com' }),
        ),
      );
      expect(errors).toHaveLength(7);
      for (const error of errors) {
        const text = `${error.message} ${JSON.stringify(error.toJSON())}`;
        expect(text).not.toMatch(
          /600000001|600000099|ada\.secret|example\.com/,
        );
        expect(text).not.toContain(code);
        expect(text).not.toContain('weakpw');
      }
    });

    it('marks every code message as sensitive', async () => {
      await signUp({ preferredChannel: 'whatsapp' });
      await accounts.verifyCode({ identifier: PHONE, code: lastCode() });
      wait(120);
      await accounts.requestPasswordReset({ identifier: PHONE });
      const messages = [...sms.sent, ...whatsapp.sent, ...mail.sent];
      expect(messages).toHaveLength(3);
      for (const message of messages) {
        expect(message.sensitive).toBe(true);
      }
    });
  });
});

describe('one-time code messages', () => {
  const base = {
    code: '123456',
    appName: 'A Twenty-Letter Name',
    minutes: 10,
  };

  it.each(
    OTP_PURPOSES.flatMap((purpose) =>
      (['en', 'fr'] as const).map((locale) => [purpose, locale] as const),
    ),
  )('the %s SMS in %s fits one SMS in the GSM alphabet', (purpose, locale) => {
    const message = otpMessage({
      ...base,
      channel: 'sms',
      identifier: { kind: 'phone', value: PHONE },
      purpose,
      locale,
    });
    if (message?.channel !== 'sms') throw new Error('expected an SMS');
    expect(smsLength(message.text)).toMatchObject({
      encoding: 'gsm7',
      segments: 1,
    });
    expect(message.text).toContain('123456');
    expect(validateMessage(message).ok).toBe(true);
  });

  it.each(OTP_PURPOSES)(
    'the %s email and WhatsApp messages are valid',
    (purpose) => {
      for (const locale of ['en', 'fr'] as const) {
        const email = otpMessage({
          ...base,
          channel: 'email',
          identifier: { kind: 'email', value: EMAIL },
          purpose,
          locale,
        });
        const chat = otpMessage({
          ...base,
          channel: 'whatsapp',
          identifier: { kind: 'phone', value: PHONE },
          purpose,
          locale,
        });
        expect(email && validateMessage(email).ok).toBe(true);
        expect(chat && validateMessage(chat).ok).toBe(true);
        if (chat?.channel !== 'whatsapp') throw new Error('expected WhatsApp');
        expect(chat.template).toBe(OTP_WHATSAPP_TEMPLATES[purpose]);
        expect(chat.parameters).toEqual(['123456']);
      }
    },
  );

  it('leaves nothing unfilled in any wording', () => {
    for (const purpose of OTP_PURPOSES) {
      for (const locale of ['en', 'fr', 'ar'] as const) {
        const sms = otpMessage({
          ...base,
          channel: 'sms',
          identifier: { kind: 'phone', value: PHONE },
          purpose,
          locale,
        });
        const email = otpMessage({
          ...base,
          channel: 'email',
          identifier: { kind: 'email', value: EMAIL },
          purpose,
          locale,
        });
        expect(JSON.stringify([sms, email])).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('writes Arabic users in English until Arabic is written', () => {
    const message = otpMessage({
      ...base,
      channel: 'sms',
      identifier: { kind: 'phone', value: PHONE },
      purpose: 'login',
      locale: 'ar',
    });
    expect(message?.channel === 'sms' && message.text).toContain(
      'sign-in code',
    );
  });

  it('has no message for a channel that cannot reach the identifier', () => {
    expect(
      otpMessage({
        ...base,
        channel: 'sms',
        identifier: { kind: 'email', value: EMAIL },
        purpose: 'login',
        locale: 'en',
      }),
    ).toBeNull();
    expect(
      otpMessage({
        ...base,
        channel: 'email',
        identifier: { kind: 'phone', value: PHONE },
        purpose: 'login',
        locale: 'en',
      }),
    ).toBeNull();
  });
});

describe('in-memory unit of work', () => {
  it('undoes what a failed action changed, and keeps what a successful one did', async () => {
    const store = createInMemoryIdentityStore();
    const user = {
      id: '018f0000-0000-7000-8000-000000000001',
      name: 'Ada Example',
      locale: 'en' as const,
      identifiers: [phoneId],
      passwordHash: null,
      createdAt: START,
    };
    await expect(
      store.unitOfWork.run(async () => {
        await store.users.create(user);
        throw new Error('failed after the change');
      }),
    ).rejects.toThrow('failed after the change');
    expect(await store.users.findById(user.id)).toBeNull();

    await store.unitOfWork.run(() => store.users.create(user));
    expect((await store.users.findById(user.id))?.name).toBe('Ada Example');
  });

  it('treats a nested call as part of the outer one', async () => {
    const store = createInMemoryIdentityStore();
    await expect(
      store.unitOfWork.run(async () => {
        await store.unitOfWork.run(() =>
          store.users.create({
            id: '018f0000-0000-7000-8000-000000000001',
            name: 'Ada Example',
            locale: 'en',
            identifiers: [phoneId],
            passwordHash: null,
            createdAt: START,
          }),
        );
        throw new Error('outer failed');
      }),
    ).rejects.toThrow('outer failed');
    expect(await store.users.findByIdentifier(phoneId)).toBeNull();
  });
});

describe('InMemoryUserRepository conformance', () => {
  for (const testCase of userRepositoryConformance) {
    it(testCase.name, () =>
      testCase.run({
        users: new InMemoryUserRepository(),
        within: (action) => action(),
      }),
    );
  }
});

describe('InMemoryOtpRepository conformance', () => {
  for (const testCase of otpRepositoryConformance) {
    it(testCase.name, () =>
      testCase.run({
        otps: new InMemoryOtpRepository(),
        within: (action) => action(),
      }),
    );
  }
});
