import type { Messenger } from '@hk/core/comms/application';
import type { Channel } from '@hk/core/comms/domain';
import {
  IDENTITY_ERRORS,
  OTP_RULES,
  channelsFor,
  isOtpCode,
  judgeOtp,
  judgeResend,
  maskIdentifier,
  otpExpiry,
  type Identifier,
  type OtpPurpose,
  type User,
} from '@hk/core/identity/domain';
import {
  DomainError,
  type Clock,
  type DomainErrorKind,
} from '@hk/platform/universal';
import { otpMessage } from './otp-messages';
import type { IdentityUnitOfWork, OtpCodec, OtpRepository } from './ports';

/**
 * Sending a one-time code and checking one. Shared by every use case that
 * needs a code: verifying an identifier, resetting a password, signing in.
 */

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

/** An identity error. Details must never hold an identifier, a code or a token. */
export const identityFailure = (
  code: string,
  message: string,
  details?: Record<string, string | number | boolean | null>,
  kind: DomainErrorKind = 'validation',
): DomainError => new DomainError(code, message, { kind, details });

/** The answer for a code that cannot be used, whatever the reason. */
export const expiredCode = (): DomainError =>
  identityFailure(
    IDENTITY_ERRORS.OTP_EXPIRED,
    'That code is no longer valid. Ask for a new one.',
  );

const bindingOf = (
  userId: string,
  identifier: Identifier,
  purpose: OtpPurpose,
): string => `${userId}|${purpose}|${identifier.kind}|${identifier.value}`;

export interface OtpFlowOptions {
  otps: OtpRepository;
  unitOfWork: IdentityUnitOfWork;
  otpCodec: OtpCodec;
  messenger: Messenger;
  clock: Clock;
  newId: () => string;
  appName: string;
}

export interface OtpFlow {
  /**
   * Makes a code, stores its hash, and sends it. Earlier codes for the same
   * identifier and purpose stop working.
   */
  issueCode(
    user: User,
    identifier: Identifier,
    purpose: OtpPurpose,
    preferred: Channel | null | undefined,
  ): Promise<CodeSent>;
  /**
   * What a caller is told when nothing is sent: the same shape as a real
   * send, so the answer does not reveal whether an account exists.
   */
  pretendSend(
    identifier: Identifier,
    preferred: Channel | null | undefined,
  ): CodeSent;
  /**
   * Checks a code and uses it up. `onAccepted` runs in the same unit of work
   * as the code being marked used, so the two happen together or not at all.
   *
   * The wrong-attempt count is saved BEFORE the error is raised: were it
   * raised inside the unit of work, the count would be rolled back and a
   * code could be guessed without limit.
   */
  redeemCode(
    user: User,
    identifier: Identifier,
    purpose: OtpPurpose,
    code: string,
    onAccepted: () => Promise<void>,
  ): Promise<void>;
}

export const createOtpFlow = (options: OtpFlowOptions): OtpFlow => {
  const { otps, unitOfWork, otpCodec, messenger, clock, newId, appName } =
    options;

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

  const issueCode: OtpFlow['issueCode'] = async (
    user,
    identifier,
    purpose,
    preferred,
  ) => {
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
        throw identityFailure(
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
      throw identityFailure(
        IDENTITY_ERRORS.OTP_DELIVERY_FAILED,
        'The code could not be sent. Try again, or use another channel.',
        { attempts: outcome.attempts.length },
        'conflict',
      );
    }
    return describeSend(identifier, outcome.receipt.channel, expiresAt);
  };

  const pretendSend: OtpFlow['pretendSend'] = (identifier, preferred) =>
    describeSend(
      identifier,
      channelOrder(identifier, preferred)[0] as Channel,
      otpExpiry(clock.now()),
    );

  const redeemCode: OtpFlow['redeemCode'] = async (
    user,
    identifier,
    purpose,
    code,
    onAccepted,
  ) => {
    if (!isOtpCode(code)) {
      throw identityFailure(
        IDENTITY_ERRORS.OTP_INVALID,
        'A code is six digits.',
      );
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
        throw identityFailure(
          IDENTITY_ERRORS.OTP_INVALID,
          'That code is not right.',
          { attemptsLeft: verdict.attemptsLeft },
        );
      case 'exhausted':
        throw identityFailure(
          IDENTITY_ERRORS.OTP_MAX_ATTEMPTS,
          'Too many wrong attempts. Ask for a new code.',
          undefined,
          'conflict',
        );
      default:
        throw expiredCode();
    }
  };

  return { issueCode, pretendSend, redeemCode };
};
