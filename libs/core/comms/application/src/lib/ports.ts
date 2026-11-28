import type {
  Channel,
  EmailMessage,
  OutgoingMessage,
  SmsMessage,
  WhatsAppMessage,
} from '@hk/core/comms/domain';

/** What a provider gives back when it accepts a message for delivery. */
export interface SendReceipt {
  channel: Channel;
  /** The provider's own id for the message, for tracing and delivery reports. */
  providerMessageId: string;
  /** When the provider accepted it, as an ISO 8601 instant. */
  acceptedAt: string;
}

/**
 * Sends messages on one channel through one provider.
 *
 * Every implementation, real or fake, passes messageSenderConformance. The
 * contract in short:
 *
 * - `send` resolves with a receipt when the provider ACCEPTED the message.
 *   Accepted is not delivered: delivery is reported later, if at all.
 * - It rejects with a comms error (commsError from the domain) and nothing
 *   else. A request that timed out is COMMS_DELIVERY_UNKNOWN, never a plain
 *   failure, because the message may have gone out.
 * - It checks the message itself and contacts nobody for an invalid one.
 * - No error it throws contains the address or the content.
 */
export interface MessageSender<Message extends OutgoingMessage> {
  readonly channel: Message['channel'];
  send(message: Message): Promise<SendReceipt>;
}

export type EmailSender = MessageSender<EmailMessage>;
export type SmsSender = MessageSender<SmsMessage>;
export type WhatsAppSender = MessageSender<WhatsAppMessage>;
