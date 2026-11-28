import type { Messenger } from '@hk/core/comms/application';
import type { Channel } from '@hk/core/comms/domain';
import {
  IDENTITY_ERRORS,
  OTP_RULES,
  channelsFor,
  checkPassword,
  isOtpCode,
  judgeOtp,
  judgeResend,
  maskIdentifier,
  nextToVerify,
  otpExpiry,
  parseEmailIdentifier,
  parseIdentifier,
  parsePhoneIdentifier,
  parseUserLocale,
  parseUserName,
  type Identifier,
  type OtpPurpose,
  type User,
} from '@hk/core/identity/domain';
import { DomainError, type Clock } from '@hk/platform/universal';
import { otpMessage } from './otp-messages';
import type {
  IdentityUnitOfWork,
  OtpCodec,
  OtpRepository,
  PasswordHasher,
  UserRepository,
} from './ports';

/**
 * Accounts: signing up, proving a phone number or email, and passwords.
 *
 * None of these runs offline: each needs the server to send or check a code,
 * or to check a password.
 */
export const ACCOUNT_USE_CASES = {
  signUp: { name: 'core.identity.sign_up', offline: false },
  verifyCode: { name: 'core.identity.verify_code', offline: false },
  resendCode: { name: 'core.identity.resend_code', offline: false },
  requestPasswordReset: {
    name: 'core.identity.request_password_reset',
    offline: false,
  },
  resetPassword: { name: 'core.identity.reset_password', offline: false },
  changePassword: { name: 'core.identity.change_password', offline: false },
} as const;

export interface SignUpInput {
  name: string;
  /** At least one of phone and email. */
  phone?: string | null;
  email?: string | null;
  /** Optional: a person may sign in with codes only. */
  password?: string | null;
  locale?: string | null;
  /** How the person would like to get codes on their phone. */
  preferredChannel?: Channel | null;
}

/** Where a code went, in a form safe to show. */
export interface CodeSent {
  /** "phone" or "email". */
  kind: Identifier['kind'];
  /** The masked destination: "+237•••••001". */
  destination: string;
  channel: Channel;
  /** ISO 8601 instant after which the code no longer works. */
  expiresAt: string;
}

export interface SignUpResult {
  userId: string;
  codeSent: CodeSent;
}

export interface VerifyCodeResult {
  userId: string;
  /** True when nothing is left to verify. */
  complete: boolean;
  /** The next code, when another identifier still needs verifying. */
  codeSent: CodeSent | null;
}

export interface AccountsOptions {
  users: UserRepository;
  otps: OtpRepository;
  unitOfWork: IdentityUnitOfWork;
  passwordHasher: PasswordHasher;
  otpCodec: OtpCodec;
  messenger: Messenger;
  clock: Clock;
  /** Makes ids. A UUID v7 generator in production. */
  newId: () => string;
  /** The product's name as it appears in messages. */
  appName: string;
}

export interface Accounts {
  /**
   * Creates an account and sends a code to its phone number, or to its email
   * when it has no phone. The account cannot sign in until a code is
   * verified.
   */
  signUp(input: SignUpInput): Promise<SignUpResult>;
  /** Verifies the code sent to a phone number or email at sign-up. */
  verifyCode(input: {
    identifier: string;
    code: string;
  }): Promise<VerifyCodeResult>;
  /**
   * Sends a new verification code. For an identifier that has no account, or
   * is already verified, it answers the same way and sends nothing.
   */
  resendCode(input: {
    identifier: string;
    channel?: Channel | null;
  }): Promise<CodeSent>;
  /**
   * Starts a password reset. It always answers the same way, whether or not
   * the identifier has an account, and sends a code only when it does.
   */
  requestPasswordReset(input: {
    identifier: string;
    channel?: Channel | null;
  }): Promise<CodeSent>;
  /** Sets a new password, given the reset code. Returns the user's id. */
  resetPassword(input: {
    identifier: string;
    code: string;
    newPassword: string;
  }): Promise<{ userId: string }>;
  /** Changes the password of a signed-in user. */
  changePassword(input: {
    userId: string;
    currentPassword: string | null;
    newPassword: string;
  }): Promise<void>;
}

const fail = (
  code: string,
  message: string,
  details?: Record<string, string | number | boolean | null>,
  kind: 'validation' | 'conflict' | 'not-found' = 'validation',
): DomainError => new DomainError(code, message, { kind, details });

const expired = (): DomainError =>
  fail(
    IDENTITY_ERRORS.OTP_EXPIRED,
    'That code is no longer valid. Ask for a new one.',
  );

const bindingOf = (
  userId: string,
  identifier: Identifier,
  purpose: OtpPurpose,
): string => `${userId}|${purpose}|${identifier.kind}|${identifier.value}`;

export const createAccounts = (options: AccountsOptions): Accounts => {
  const {
    users,
    otps,
    unitOfWork,
    passwordHasher,
    otpCodec,
    messenger,
    clock,
    newId,
    appName,
  } = options;

  const nowIso = (): string => clock.now().toISOString();

  /** The channels to try for an identifier, the preferred one first. */
  const channelOrder = (
    identifier: Identifier,
    preferred: Channel | null | undefined,
  ): Channel[] => {
    const usable = channelsFor(identifier.kind);
    return preferred && usable.includes(preferred)
      ? [preferred, ...usable.filter((channel) => channel !== preferred)]
      : [...usable];
  };

  const describeSend = (
    identifier: Identifier,
    channel: Channel,
    expiresAt: string,
  ): CodeSent => ({
    kind: identifier.kind,
    destination: maskIdentifier(identifier),
    channel,
    expiresAt,
  });

  /**
   * Makes a code, stores its hash, and sends it. Earlier codes for the same
   * identifier and purpose stop working.
   */
  const issueCode = async (
    user: User,
    identifier: Identifier,
    purpose: OtpPurpose,
    preferred: Channel | null | undefined,
  ): Promise<CodeSent> => {
    const now = clock.now();
    const since = new Date(
      now.getTime() - OTP_RULES.resendWindowSeconds * 1000,
    ).toISOString();
    const channels = channelOrder(identifier, preferred);
    const firstChannel = channels[0] as Channel;
    const code = otpCodec.generate();
    const challengeId = newId();
    const expiresAt = otpExpiry(now);

    await unitOfWork.run(async () => {
      const verdict = judgeResend(
        await otps.sentTimes(identifier, purpose, since),
        now.toISOString(),
      );
      if (!verdict.allowed) {
        throw fail(
          verdict.reason === 'too_soon'
            ? IDENTITY_ERRORS.OTP_RESEND_TOO_SOON
            : IDENTITY_ERRORS.OTP_RESEND_LIMIT,
          'A code was sent a moment ago. Wait before asking for another.',
          { retryAfterSeconds: verdict.retryAfterSeconds },
          'conflict',
        );
      }
      await otps.consumeAll(identifier, purpose, now.toISOString());
      await otps.create({
        id: challengeId,
        userId: user.id,
        identifier,
        purpose,
        channel: firstChannel,
        codeHash: otpCodec.hash(code, bindingOf(user.id, identifier, purpose)),
        createdAt: now.toISOString(),
        expiresAt,
        attempts: 0,
        consumedAt: null,
      });
    });

    // The message is sent after the transaction: a transaction must not wait
    // on a provider. A second copy of a code is harmless, so a channel that
    // times out does not stop the next one being tried.
    const messages = channels
      .map((channel) =>
        otpMessage({
          channel,
          identifier,
          purpose,
          code,
          locale: user.locale,
          appName,
          minutes: OTP_RULES.ttlSeconds / 60,
        }),
      )
      .filter((message) => message !== null);
    const outcome = await messenger.sendFirst(messages, {
      onUnknown: 'continue',
    });
    if (!outcome.delivered) {
      // Nobody has the code. It is removed, so it cannot be used and does
      // not make the person wait before trying again.
      await unitOfWork.run(() => otps.discard(challengeId));
      throw fail(
        IDENTITY_ERRORS.OTP_DELIVERY_FAILED,
        'The code could not be sent. Try again, or use another channel.',
        { attempts: outcome.attempts.length },
        'conflict',
      );
    }
    return describeSend(identifier, outcome.receipt.channel, expiresAt);
  };

  /**
   * What a caller is told when nothing is sent: the same shape as a real
   * send, so the answer does not reveal whether an account exists.
   */
  const pretendSend = (
    identifier: Identifier,
    preferred: Channel | null | undefined,
  ): CodeSent =>
    describeSend(
      identifier,
      channelOrder(identifier, preferred)[0] as Channel,
      otpExpiry(clock.now()),
    );

  /**
   * Checks a code and uses it up. The wrong-attempt count is saved BEFORE
   * the error is raised: were it raised inside the unit of work, the count
   * would be rolled back and a code could be guessed without limit.
   */
  const redeemCode = async (
    user: User,
    identifier: Identifier,
    purpose: OtpPurpose,
    code: string,
    onAccepted: () => Promise<void>,
  ): Promise<void> => {
    if (!isOtpCode(code)) {
      throw fail(IDENTITY_ERRORS.OTP_INVALID, 'A code is six digits.');
    }
    const submitted = otpCodec.hash(
      code,
      bindingOf(user.id, identifier, purpose),
    );
    const verdict = await unitOfWork.run(async () => {
      const challenge = await otps.findLive(identifier, purpose);
      // A code issued to another user for the same identifier is not this
      // user's code.
      const own = challenge && challenge.userId === user.id ? challenge : null;
      const result = judgeOtp(own, submitted, nowIso());
      if (!own) return result;
      if (result.outcome === 'accepted') {
        await otps.consume(own.id, nowIso());
        await onAccepted();
      } else if (result.outcome === 'wrong') {
        await otps.recordAttempt(own.id);
      } else if (result.outcome === 'exhausted') {
        await otps.recordAttempt(own.id);
        await otps.consume(own.id, nowIso());
      }
      return result;
    });

    switch (verdict.outcome) {
      case 'accepted':
        return;
      case 'wrong':
        throw fail(IDENTITY_ERRORS.OTP_INVALID, 'That code is not right.', {
          attemptsLeft: verdict.attemptsLeft,
        });
      case 'exhausted':
        throw fail(
          IDENTITY_ERRORS.OTP_MAX_ATTEMPTS,
          'Too many wrong attempts. Ask for a new code.',
          undefined,
          'conflict',
        );
      default:
        throw expired();
    }
  };

  const signUp = async (input: SignUpInput): Promise<SignUpResult> => {
    const name = parseUserName(input.name);
    if (!name.ok) throw name.error;

    const identifiers: Identifier[] = [];
    if (input.phone) {
      const phone = parsePhoneIdentifier(input.phone);
      if (!phone.ok) throw phone.error;
      identifiers.push(phone.value);
    }
    if (input.email) {
      const email = parseEmailIdentifier(input.email);
      if (!email.ok) throw email.error;
      identifiers.push(email.value);
    }
    if (identifiers.length === 0) {
      throw fail(
        IDENTITY_ERRORS.IDENTIFIER_REQUIRED,
        'Give a phone number or an email address.',
      );
    }

    let passwordHash: string | null = null;
    if (input.password) {
      const password = checkPassword(input.password, {
        identity: [name.value, ...identifiers.map((item) => item.value)],
      });
      if (!password.ok) throw password.error;
      // Hashing is slow on purpose, so it happens before the transaction.
      passwordHash = await passwordHasher.hash(password.value);
    }

    const user = await unitOfWork.run(async () => {
      for (const identifier of identifiers) {
        const holder = await users.findByIdentifier(identifier);
        if (!holder) continue;
        const held = holder.identifiers.find(
          (item) =>
            item.kind === identifier.kind && item.value === identifier.value,
        );
        if (held?.verifiedAt) {
          throw fail(
            IDENTITY_ERRORS.IDENTIFIER_TAKEN,
            'An account with this phone number or email already exists.',
            { kind: identifier.kind },
            'conflict',
          );
        }
        // Nobody proved they hold it. An abandoned sign-up is cleared away,
        // and an unverified extra on a live account is released: a phone
        // number or email is reserved by verifying it, not by typing it.
        if (holder.status === 'pending') {
          await users.discardPending(holder.id);
        } else {
          await users.releaseUnverifiedIdentifier(holder.id, identifier);
        }
      }
      return users.create({
        id: newId(),
        name: name.value,
        locale: parseUserLocale(input.locale),
        identifiers,
        passwordHash,
        createdAt: nowIso(),
      });
    });

    const first = nextToVerify(user) as Identifier;
    const codeSent = await issueCode(
      user,
      first,
      'verify_identifier',
      input.preferredChannel,
    );
    return { userId: user.id, codeSent };
  };

  const verifyCode = async (input: {
    identifier: string;
    code: string;
  }): Promise<VerifyCodeResult> => {
    const identifier = parseIdentifier(input.identifier);
    if (!identifier.ok) throw identifier.error;
    const user = await unitOfWork.run(() =>
      users.findByIdentifier(identifier.value),
    );
    // No account: answered like a dead code, so the reply does not say
    // whether the identifier is known.
    if (!user) throw expired();

    let verified = user;
    await redeemCode(
      user,
      identifier.value,
      'verify_identifier',
      input.code,
      async () => {
        verified = await users.markIdentifierVerified(
          user.id,
          identifier.value,
          nowIso(),
        );
      },
    );

    const next = nextToVerify(verified);
    if (!next) {
      return { userId: verified.id, complete: true, codeSent: null };
    }
    const codeSent = await issueCode(verified, next, 'verify_identifier', null);
    return { userId: verified.id, complete: false, codeSent };
  };

  const resendCode = async (input: {
    identifier: string;
    channel?: Channel | null;
  }): Promise<CodeSent> => {
    const identifier = parseIdentifier(input.identifier);
    if (!identifier.ok) throw identifier.error;
    const user = await unitOfWork.run(() =>
      users.findByIdentifier(identifier.value),
    );
    const held = user?.identifiers.find(
      (item) =>
        item.kind === identifier.value.kind &&
        item.value === identifier.value.value,
    );
    if (!user || !held || held.verifiedAt !== null) {
      return pretendSend(identifier.value, input.channel);
    }
    return issueCode(
      user,
      identifier.value,
      'verify_identifier',
      input.channel,
    );
  };

  const requestPasswordReset = async (input: {
    identifier: string;
    channel?: Channel | null;
  }): Promise<CodeSent> => {
    const identifier = parseIdentifier(input.identifier);
    if (!identifier.ok) throw identifier.error;
    const user = await unitOfWork.run(() =>
      users.findByIdentifier(identifier.value),
    );
    const held = user?.identifiers.find(
      (item) =>
        item.kind === identifier.value.kind &&
        item.value === identifier.value.value,
    );
    // A code goes only to an identifier the person has proved they hold, on
    // an account that may sign in.
    if (!user || !held?.verifiedAt || user.status !== 'active') {
      return pretendSend(identifier.value, input.channel);
    }
    return issueCode(user, identifier.value, 'password_reset', input.channel);
  };

  const resetPassword = async (input: {
    identifier: string;
    code: string;
    newPassword: string;
  }): Promise<{ userId: string }> => {
    const identifier = parseIdentifier(input.identifier);
    if (!identifier.ok) throw identifier.error;
    const user = await unitOfWork.run(() =>
      users.findByIdentifier(identifier.value),
    );
    if (!user || user.status !== 'active') throw expired();

    // The password is checked and hashed before the code is used, so a weak
    // password does not waste the code.
    const password = checkPassword(input.newPassword, {
      identity: [user.name, ...user.identifiers.map((item) => item.value)],
    });
    if (!password.ok) throw password.error;
    const hash = await passwordHasher.hash(password.value);

    await redeemCode(user, identifier.value, 'password_reset', input.code, () =>
      users.setPasswordHash(user.id, hash, nowIso()),
    );
    return { userId: user.id };
  };

  const changePassword = async (input: {
    userId: string;
    currentPassword: string | null;
    newPassword: string;
  }): Promise<void> => {
    const [user, currentHash] = await unitOfWork.run(
      async () =>
        [
          await users.findById(input.userId),
          await users.passwordHashOf(input.userId),
        ] as const,
    );
    if (!user || user.status !== 'active') {
      throw fail(
        IDENTITY_ERRORS.USER_NOT_FOUND,
        'The account was not found.',
        undefined,
        'not-found',
      );
    }
    // An account with a password must prove it knows the old one. An account
    // without one (codes only) is setting its first.
    if (currentHash !== null) {
      const matches =
        typeof input.currentPassword === 'string' &&
        (await passwordHasher.verify(input.currentPassword, currentHash));
      if (!matches) {
        throw fail(
          IDENTITY_ERRORS.CREDENTIALS_INVALID,
          'The current password is not right.',
        );
      }
    }
    const password = checkPassword(input.newPassword, {
      identity: [user.name, ...user.identifiers.map((item) => item.value)],
    });
    if (!password.ok) throw password.error;
    const hash = await passwordHasher.hash(password.value);
    await unitOfWork.run(() => users.setPasswordHash(user.id, hash, nowIso()));
  };

  return {
    signUp,
    verifyCode,
    resendCode,
    requestPasswordReset,
    resetPassword,
    changePassword,
  };
};
