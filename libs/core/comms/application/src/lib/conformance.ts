import {
  COMMS_ERRORS,
  retryAdviceOf,
  type OutgoingMessage,
} from '@hk/core/comms/domain';
import {
  ConformanceFailure,
  expectEqual,
  expectTrue,
  type ConformanceCase,
} from '@hk/platform/test-kit';
import { isDomainError } from '@hk/platform/universal';
import type { MessageSender } from './ports';

/**
 * What every message sender must do, whichever channel and provider.
 *
 * Each adapter's test file runs the suite against itself, once per channel
 * it implements:
 *
 *   for (const testCase of messageSenderConformance) {
 *     it(testCase.name, () => testCase.run(subject));
 *   }
 *
 * A real adapter runs it against the provider's sandbox or a local stand-in,
 * never against live delivery.
 */
export interface MessageSenderSubject<
  Message extends OutgoingMessage = OutgoingMessage,
> {
  sender: MessageSender<Message>;
  /** A message the provider will accept. A new one on every call. */
  validMessage(): Message;
  /** The same, to an address that is malformed. */
  messageToBadAddress(): Message;
  /** The same, with content the channel does not allow. */
  messageWithBadContent(): Message;
  /**
   * Makes the next send fail at the provider:
   *   "rejected"     the provider refuses the message
   *   "unavailable"  the provider cannot be reached, or answers "try later"
   *   "timeout"      the provider does not answer in time
   */
  induce(failure: 'rejected' | 'unavailable' | 'timeout'): void;
  /** How many messages the provider has received so far. */
  providerReceived(): number;
  /** Text that must never appear in an error: the address and the content of the messages above. */
  secrets(): string[];
}

type Case = ConformanceCase<MessageSenderSubject>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Runs `action`, expecting a rejection, and returns what was thrown. */
const rejection = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new ConformanceFailure('expected the send to be rejected');
};

const expectCommsError = (
  error: unknown,
  code: string,
  retry: string,
  channel: string,
  what: string,
): void => {
  if (!isDomainError(error)) {
    throw new ConformanceFailure(
      `${what}: expected a comms error, got ${String(error)}`,
    );
  }
  expectEqual(error.code, code, `${what}: error code`);
  expectEqual(retryAdviceOf(error), retry, `${what}: retry advice`);
  if (
    code !== COMMS_ERRORS.ADDRESS_INVALID &&
    code !== COMMS_ERRORS.MESSAGE_INVALID
  ) {
    expectEqual(
      error.details['channel'],
      channel,
      `${what}: channel in details`,
    );
    expectEqual(error.details['retry'], retry, `${what}: retry in details`);
  }
};

const expectNoSecrets = (
  error: unknown,
  secrets: readonly string[],
  what: string,
): void => {
  const text = isDomainError(error)
    ? `${error.message} ${JSON.stringify(error.toJSON())}`
    : String(error);
  for (const secret of secrets) {
    if (secret.length >= 4 && text.includes(secret)) {
      throw new ConformanceFailure(
        `${what}: the error contains the address or the content of the message`,
      );
    }
  }
};

export const messageSenderConformance: readonly Case[] = [
  {
    name: 'accepts a valid message and returns a receipt',
    run: async (subject) => {
      const before = subject.providerReceived();
      const receipt = await subject.sender.send(subject.validMessage());
      expectEqual(receipt.channel, subject.sender.channel, 'receipt channel');
      expectTrue(
        typeof receipt.providerMessageId === 'string' &&
          receipt.providerMessageId.length > 0,
        'the receipt has a provider message id',
      );
      expectTrue(
        ISO_INSTANT.test(receipt.acceptedAt),
        'acceptedAt is an ISO 8601 instant',
      );
      expectEqual(subject.providerReceived(), before + 1, 'messages received');
    },
  },
  {
    name: 'gives each message its own provider id',
    run: async (subject) => {
      const first = await subject.sender.send(subject.validMessage());
      const second = await subject.sender.send(subject.validMessage());
      expectTrue(
        first.providerMessageId !== second.providerMessageId,
        'two sends have different ids',
      );
    },
  },
  {
    name: 'refuses a malformed address without contacting the provider',
    run: async (subject) => {
      const before = subject.providerReceived();
      const error = await rejection(() =>
        subject.sender.send(subject.messageToBadAddress()),
      );
      expectCommsError(
        error,
        COMMS_ERRORS.ADDRESS_INVALID,
        'never',
        subject.sender.channel,
        'a bad address',
      );
      expectEqual(subject.providerReceived(), before, 'messages received');
    },
  },
  {
    name: 'refuses content the channel does not allow without contacting the provider',
    run: async (subject) => {
      const before = subject.providerReceived();
      const error = await rejection(() =>
        subject.sender.send(subject.messageWithBadContent()),
      );
      expectCommsError(
        error,
        COMMS_ERRORS.MESSAGE_INVALID,
        'never',
        subject.sender.channel,
        'bad content',
      );
      expectEqual(subject.providerReceived(), before, 'messages received');
    },
  },
  {
    name: 'reports a refusal by the provider as final',
    run: async (subject) => {
      subject.induce('rejected');
      const error = await rejection(() =>
        subject.sender.send(subject.validMessage()),
      );
      expectCommsError(
        error,
        COMMS_ERRORS.PROVIDER_REJECTED,
        'never',
        subject.sender.channel,
        'a refusal',
      );
    },
  },
  {
    name: 'reports an unreachable provider as worth retrying later',
    run: async (subject) => {
      subject.induce('unavailable');
      const error = await rejection(() =>
        subject.sender.send(subject.validMessage()),
      );
      expectCommsError(
        error,
        COMMS_ERRORS.PROVIDER_UNAVAILABLE,
        'later',
        subject.sender.channel,
        'an unreachable provider',
      );
    },
  },
  {
    name: 'reports a timeout as unknown, never as failed',
    run: async (subject) => {
      subject.induce('timeout');
      const error = await rejection(() =>
        subject.sender.send(subject.validMessage()),
      );
      // The message may have gone out. Calling it failed would invite a
      // blind retry and a second copy.
      expectCommsError(
        error,
        COMMS_ERRORS.DELIVERY_UNKNOWN,
        'unknown',
        subject.sender.channel,
        'a timeout',
      );
    },
  },
  {
    name: 'works again after a failure',
    run: async (subject) => {
      for (const failure of ['rejected', 'unavailable', 'timeout'] as const) {
        subject.induce(failure);
        await rejection(() => subject.sender.send(subject.validMessage()));
        const receipt = await subject.sender.send(subject.validMessage());
        expectTrue(
          receipt.providerMessageId.length > 0,
          `a send after "${failure}" is accepted`,
        );
      }
    },
  },
  {
    name: 'never puts the address or the content in an error',
    run: async (subject) => {
      const secrets = subject.secrets();
      expectTrue(
        secrets.some((secret) => secret.length >= 4),
        'the subject names at least one secret to look for',
      );
      expectNoSecrets(
        await rejection(() =>
          subject.sender.send(subject.messageToBadAddress()),
        ),
        secrets,
        'a bad address',
      );
      expectNoSecrets(
        await rejection(() =>
          subject.sender.send(subject.messageWithBadContent()),
        ),
        secrets,
        'bad content',
      );
      for (const failure of ['rejected', 'unavailable', 'timeout'] as const) {
        subject.induce(failure);
        expectNoSecrets(
          await rejection(() => subject.sender.send(subject.validMessage())),
          secrets,
          failure,
        );
      }
    },
  },
];
