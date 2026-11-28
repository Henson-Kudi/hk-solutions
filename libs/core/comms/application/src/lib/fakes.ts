import {
  COMMS_ERRORS,
  commsError,
  validateMessage,
  type EmailMessage,
  type OutgoingMessage,
  type SmsMessage,
  type WhatsAppMessage,
} from '@hk/core/comms/domain';
import { systemClock, type Clock } from '@hk/platform/universal';
import type { MessageSender, SendReceipt } from './ports';

/**
 * Fake senders: they "send" by keeping the message in a list.
 *
 * Use them in tests and in local development, where no real email, SMS or
 * WhatsApp message must ever leave. They obey the same contract as a real
 * sender (they pass messageSenderConformance), so code tested against them
 * behaves the same against a provider.
 */

/** A failure the next send should have. */
export type InducedFailure = 'rejected' | 'unavailable' | 'timeout';

export class FakeSender<Message extends OutgoingMessage>
  implements MessageSender<Message>
{
  /** Every message the fake provider accepted, oldest first. */
  readonly sent: Message[] = [];
  private readonly queued: InducedFailure[] = [];
  private counter = 0;

  constructor(
    readonly channel: Message['channel'],
    private readonly clock: Clock = systemClock,
  ) {}

  /** Makes the next `times` sends fail in the given way. */
  failNext(failure: InducedFailure, times = 1): void {
    for (let count = 0; count < times; count += 1) {
      this.queued.push(failure);
    }
  }

  /** The last message accepted, or undefined. */
  last(): Message | undefined {
    return this.sent[this.sent.length - 1];
  }

  /** Forgets everything sent and every queued failure. */
  reset(): void {
    this.sent.length = 0;
    this.queued.length = 0;
  }

  async send(message: Message): Promise<SendReceipt> {
    const checked = validateMessage(message);
    if (!checked.ok) {
      throw checked.error;
    }
    if (checked.value.channel !== this.channel) {
      throw commsError(COMMS_ERRORS.MESSAGE_INVALID, this.channel, {
        reason: 'wrong_channel',
      });
    }
    const failure = this.queued.shift();
    if (failure === 'rejected') {
      throw commsError(COMMS_ERRORS.PROVIDER_REJECTED, this.channel, {
        reason: 'fake_rejected',
      });
    }
    if (failure === 'unavailable') {
      throw commsError(COMMS_ERRORS.PROVIDER_UNAVAILABLE, this.channel);
    }
    if (failure === 'timeout') {
      // A real timeout can happen after the provider took the message. The
      // fake does not keep it, which is the harder case for the caller.
      throw commsError(COMMS_ERRORS.DELIVERY_UNKNOWN, this.channel);
    }
    this.counter += 1;
    this.sent.push(checked.value);
    return {
      channel: this.channel,
      providerMessageId: `fake-${this.channel}-${this.counter}`,
      acceptedAt: this.clock.now().toISOString(),
    };
  }
}

export const createFakeEmailSender = (
  clock?: Clock,
): FakeSender<EmailMessage> => new FakeSender<EmailMessage>('email', clock);

export const createFakeSmsSender = (clock?: Clock): FakeSender<SmsMessage> =>
  new FakeSender<SmsMessage>('sms', clock);

export const createFakeWhatsAppSender = (
  clock?: Clock,
): FakeSender<WhatsAppMessage> =>
  new FakeSender<WhatsAppMessage>('whatsapp', clock);
