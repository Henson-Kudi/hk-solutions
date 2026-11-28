import { DomainError } from '@hk/platform/universal';

/**
 * How sending can fail. Every sender, real or fake, reports failure with one
 * of these, so the code that calls it can decide what to do without knowing
 * the provider.
 *
 *   ADDRESS_INVALID       the address is malformed; nothing was sent
 *   MESSAGE_INVALID       the message breaks a rule of its channel; nothing was sent
 *   CHANNEL_UNAVAILABLE   no sender is set up for the channel
 *   PROVIDER_REJECTED     the provider refused the message; retrying will not help
 *   PROVIDER_UNAVAILABLE  the provider could not be reached or is overloaded; retry later
 *   DELIVERY_UNKNOWN      the request timed out; the message MAY have been sent
 */
export const COMMS_ERRORS = {
  ADDRESS_INVALID: 'COMMS_ADDRESS_INVALID',
  MESSAGE_INVALID: 'COMMS_MESSAGE_INVALID',
  CHANNEL_UNAVAILABLE: 'COMMS_CHANNEL_UNAVAILABLE',
  PROVIDER_REJECTED: 'COMMS_PROVIDER_REJECTED',
  PROVIDER_UNAVAILABLE: 'COMMS_PROVIDER_UNAVAILABLE',
  DELIVERY_UNKNOWN: 'COMMS_DELIVERY_UNKNOWN',
} as const;

export type CommsErrorCode = (typeof COMMS_ERRORS)[keyof typeof COMMS_ERRORS];

export const CHANNELS = ['email', 'sms', 'whatsapp'] as const;

export type Channel = (typeof CHANNELS)[number];

/**
 * What a caller should do about a failure.
 *
 *   never    sending the same message again cannot succeed
 *   later    it may succeed later; safe to retry, nothing was sent
 *   unknown  it may already have been sent; a retry can deliver it twice
 */
export type RetryAdvice = 'never' | 'later' | 'unknown';

const ADVICE: Record<CommsErrorCode, RetryAdvice> = {
  [COMMS_ERRORS.ADDRESS_INVALID]: 'never',
  [COMMS_ERRORS.MESSAGE_INVALID]: 'never',
  [COMMS_ERRORS.CHANNEL_UNAVAILABLE]: 'never',
  [COMMS_ERRORS.PROVIDER_REJECTED]: 'never',
  [COMMS_ERRORS.PROVIDER_UNAVAILABLE]: 'later',
  [COMMS_ERRORS.DELIVERY_UNKNOWN]: 'unknown',
};

const MESSAGES: Record<CommsErrorCode, string> = {
  [COMMS_ERRORS.ADDRESS_INVALID]: 'The address is not valid.',
  [COMMS_ERRORS.MESSAGE_INVALID]: 'The message is not valid for its channel.',
  [COMMS_ERRORS.CHANNEL_UNAVAILABLE]: 'That channel is not set up.',
  [COMMS_ERRORS.PROVIDER_REJECTED]: 'The provider refused the message.',
  [COMMS_ERRORS.PROVIDER_UNAVAILABLE]:
    'The provider could not be reached. Try again later.',
  [COMMS_ERRORS.DELIVERY_UNKNOWN]:
    'The provider did not answer in time. The message may have been sent.',
};

export const isCommsErrorCode = (value: unknown): value is CommsErrorCode =>
  typeof value === 'string' &&
  (Object.values(COMMS_ERRORS) as string[]).includes(value);

/**
 * Builds a sending failure. The details carry the channel and the retry
 * advice, and nothing else: never the address, never the message.
 */
export const commsError = (
  code: CommsErrorCode,
  channel: Channel,
  options: { reason?: string; cause?: unknown } = {},
): DomainError =>
  new DomainError(code, MESSAGES[code], {
    kind: ADVICE[code] === 'never' ? 'validation' : 'conflict',
    details: {
      channel,
      retry: ADVICE[code],
      // A short provider reason such as "template_not_approved". Adapters
      // must pass a code here, never free text from the provider's response.
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
    cause: options.cause,
  });

/** What to do about a failure. Anything that is not a comms error is "unknown". */
export const retryAdviceOf = (error: unknown): RetryAdvice => {
  const code = (error as { code?: unknown } | null)?.code;
  return isCommsErrorCode(code) ? ADVICE[code] : 'unknown';
};
