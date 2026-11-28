import type { Messenger } from '@hk/core/comms/application';
import type { Channel } from '@hk/core/comms/domain';
import {
  IDENTITY_ERRORS,
  checkPassword,
  nextToVerify,
  parseEmailIdentifier,
  parseIdentifier,
  parsePhoneIdentifier,
  parseUserLocale,
  parseUserName,
  type Identifier,
} from '@hk/core/identity/domain';
import type { Clock } from '@hk/platform/universal';
import {
  createOtpFlow,
  expiredCode as expired,
  identityFailure as fail,
  type CodeSent,
} from './otp-flow';
import type {
  IdentityUnitOfWork,
  OtpCodec,
  OtpRepository,
  PasswordAttemptsRepository,
  PasswordHasher,
  SessionRepository,
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
  /** Sessions are ended when a password is reset or changed. */
  sessions: SessionRepository;
  /** The count of wrong passwords is forgotten when a password is reset. */
  passwordAttempts: PasswordAttemptsRepository;
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
  /**
   * Sets a new password, given the reset code. Returns the user's id.
   * Every session of the user is ended: whoever knew the old password, or
   * held a session, is out.
   */
  resetPassword(input: {
    identifier: string;
    code: string;
    newPassword: string;
  }): Promise<{ userId: string }>;
  /**
   * Changes the password of a signed-in user. Every other session of the
   * user is ended; the one named by `keepSessionId` stays.
   */
  changePassword(input: {
    userId: string;
    currentPassword: string | null;
    newPassword: string;
    keepSessionId?: string | null;
  }): Promise<void>;
}

export const createAccounts = (options: AccountsOptions): Accounts => {
  const {
    users,
    sessions,
    passwordAttempts,
    unitOfWork,
    passwordHasher,
    clock,
    newId,
  } = options;
  const { issueCode, pretendSend, redeemCode } = createOtpFlow(options);

  const nowIso = (): string => clock.now().toISOString();

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

    await redeemCode(
      user,
      identifier.value,
      'password_reset',
      input.code,
      async () => {
        const at = nowIso();
        await users.setPasswordHash(user.id, hash, at);
        await sessions.revokeAllForUser(user.id, at, 'password_changed');
        await passwordAttempts.clear(user.id);
      },
    );
    return { userId: user.id };
  };

  const changePassword = async (input: {
    userId: string;
    currentPassword: string | null;
    newPassword: string;
    keepSessionId?: string | null;
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
    await unitOfWork.run(async () => {
      const at = nowIso();
      await users.setPasswordHash(user.id, hash, at);
      await sessions.revokeAllForUser(
        user.id,
        at,
        'password_changed',
        input.keepSessionId ?? null,
      );
    });
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
