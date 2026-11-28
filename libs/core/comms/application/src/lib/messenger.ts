import {
  COMMS_ERRORS,
  commsError,
  isCommsErrorCode,
  retryAdviceOf,
  validateMessage,
  type Channel,
  type CommsErrorCode,
  type OutgoingMessage,
  type RetryAdvice,
} from '@hk/core/comms/domain';
import { isDomainError, type DomainError } from '@hk/platform/universal';
import type {
  EmailSender,
  MessageSender,
  SendReceipt,
  SmsSender,
  WhatsAppSender,
} from './ports';

/**
 * The messenger: one place to send a message on any channel.
 *
 * Neither use case runs offline. A device queues what it wants sent as a
 * sync command, and the server sends it.
 */
export const COMMS_USE_CASES = {
  send: { name: 'core.comms.send', offline: false },
  sendFirst: { name: 'core.comms.send_first', offline: false },
} as const;

export interface MessengerOptions {
  email?: EmailSender;
  sms?: SmsSender;
  whatsapp?: WhatsAppSender;
}

/** What happened on one channel during sendFirst. */
export interface DeliveryAttempt {
  channel: Channel;
  /** "accepted", or the code of the failure. */
  outcome: 'accepted' | CommsErrorCode;
  retry?: RetryAdvice;
}

export type DeliveryOutcome =
  | { delivered: true; receipt: SendReceipt; attempts: DeliveryAttempt[] }
  | { delivered: false; error: DomainError; attempts: DeliveryAttempt[] };

export interface SendFirstOptions {
  /**
   * What to do when a channel times out, so the message may or may not have
   * gone out.
   *
   *   "stop"      (default) do not try the next channel: the person might
   *               get the message twice.
   *   "continue"  try the next channel anyway. Right for a one-time code,
   *               where a second copy is harmless and none at all locks the
   *               person out.
   */
  onUnknown?: 'stop' | 'continue';
}

export interface Messenger {
  /** The channels that have a sender. */
  channels(): Channel[];
  /**
   * Sends one message. Resolves with the provider's receipt, or rejects with
   * a comms error.
   */
  send(message: OutgoingMessage): Promise<SendReceipt>;
  /**
   * Tries the messages in order and stops at the first one a provider
   * accepts: WhatsApp, then SMS, for example. It does not throw for a
   * failed delivery; the outcome says what happened on each channel.
   */
  sendFirst(
    messages: readonly OutgoingMessage[],
    options?: SendFirstOptions,
  ): Promise<DeliveryOutcome>;
}

/**
 * Anything a sender throws that is not a comms error is a bug in that
 * sender. The message may have gone out, so it is reported as unknown.
 */
const asCommsError = (error: unknown, channel: Channel): DomainError =>
  isDomainError(error) && isCommsErrorCode(error.code)
    ? error
    : commsError(COMMS_ERRORS.DELIVERY_UNKNOWN, channel, { cause: error });

export const createMessenger = (options: MessengerOptions): Messenger => {
  const senders: Partial<Record<Channel, MessageSender<OutgoingMessage>>> = {};
  for (const sender of [options.email, options.sms, options.whatsapp]) {
    if (sender) {
      senders[sender.channel] = sender as MessageSender<OutgoingMessage>;
    }
  }

  const send = async (message: OutgoingMessage): Promise<SendReceipt> => {
    const checked = validateMessage(message);
    if (!checked.ok) {
      throw checked.error;
    }
    const channel = checked.value.channel;
    const sender = senders[channel];
    if (!sender) {
      throw commsError(COMMS_ERRORS.CHANNEL_UNAVAILABLE, channel);
    }
    try {
      return await sender.send(checked.value);
    } catch (error) {
      throw asCommsError(error, channel);
    }
  };

  const sendFirst = async (
    messages: readonly OutgoingMessage[],
    sendOptions: SendFirstOptions = {},
  ): Promise<DeliveryOutcome> => {
    const attempts: DeliveryAttempt[] = [];
    let lastError: DomainError | undefined;
    for (const message of messages) {
      const channel: Channel = message?.channel;
      try {
        const receipt = await send(message);
        attempts.push({ channel: receipt.channel, outcome: 'accepted' });
        return { delivered: true, receipt, attempts };
      } catch (error) {
        const failure = error as DomainError;
        const retry = retryAdviceOf(failure);
        lastError = failure;
        attempts.push({
          channel,
          outcome: failure.code as CommsErrorCode,
          retry,
        });
        if (retry === 'unknown' && sendOptions.onUnknown !== 'continue') {
          break;
        }
      }
    }
    return {
      delivered: false,
      error:
        lastError ??
        commsError(COMMS_ERRORS.MESSAGE_INVALID, 'email', {
          reason: 'no_messages',
        }),
      attempts,
    };
  };

  return {
    channels: () => Object.keys(senders) as Channel[],
    send,
    sendFirst,
  };
};
