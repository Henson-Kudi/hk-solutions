import { DomainError, err, ok, type Result } from '@hk/platform/universal';
import { parseEmailAddress, parsePhoneNumber } from './address';
import { COMMS_ERRORS, type Channel } from './errors';

/**
 * Messages: what is sent on each channel, and the rules each must obey.
 *
 * A message is checked here, before any provider is contacted, so a bad one
 * costs nothing and fails the same way whoever the provider is.
 */

interface Common {
  /**
   * True when the content must never be stored or logged: a one-time code, a
   * password reset link. Senders and logs keep the fact that a message was
   * sent, never what it said.
   */
  readonly sensitive?: boolean;
}

export interface EmailMessage extends Common {
  readonly channel: 'email';
  readonly to: string;
  readonly subject: string;
  /** The plain-text body. Always required: not every reader shows HTML. */
  readonly text: string;
  /** An HTML body, shown instead of the text where the reader supports it. */
  readonly html?: string;
}

export interface SmsMessage extends Common {
  readonly channel: 'sms';
  /** E.164: "+237677123456". */
  readonly to: string;
  readonly text: string;
}

/**
 * A WhatsApp message a business starts must use a template approved by
 * WhatsApp in advance. The template is named here and its blanks are filled
 * from `parameters`, in order.
 */
export interface WhatsAppMessage extends Common {
  readonly channel: 'whatsapp';
  /** E.164: "+237677123456". */
  readonly to: string;
  /** The approved template's name: "otp_code", "invoice_reminder". */
  readonly template: string;
  /** The language of the template: "en", "fr", "ar". */
  readonly language: string;
  readonly parameters: readonly string[];
}

export type OutgoingMessage = EmailMessage | SmsMessage | WhatsAppMessage;

const SUBJECT_MAX = 200;
const EMAIL_BODY_MAX = 500_000;
const TEMPLATE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const LANGUAGE = /^[a-z]{2}(_[A-Z]{2})?$/;
const PARAMETERS_MAX = 20;
const PARAMETER_MAX = 1024;
/** The longest SMS accepted, in segments. Each segment is billed. */
export const SMS_MAX_SEGMENTS = 4;

const invalid = (why: string): DomainError =>
  new DomainError(
    COMMS_ERRORS.MESSAGE_INVALID,
    `The message is not valid: ${why}.`,
  );

const hasLineBreak = (text: string): boolean => /[\r\n]/.test(text);

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

// ── SMS length ──────────────────────────────────────────────────────────────

/**
 * The characters an SMS carries at 7 bits each (the GSM 03.38 basic set). A
 * message using only these fits 160 characters; any other character switches
 * the whole message to 16 bits, and it fits 70.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** These count as two characters each in the 7-bit alphabet. */
const GSM_EXTENDED = '^{}\\[~]|€';

export interface SmsLength {
  /** "gsm7" when every character is in the GSM alphabet, otherwise "ucs2". */
  encoding: 'gsm7' | 'ucs2';
  /** Length in the units of that encoding. */
  units: number;
  /** How many SMS the text takes. Each is billed. */
  segments: number;
}

/** How long a text is as an SMS, and how many messages it takes. */
export const smsLength = (text: string): SmsLength => {
  let gsmUnits = 0;
  let isGsm = true;
  for (const char of Array.from(text)) {
    if (GSM_BASIC.includes(char)) {
      gsmUnits += 1;
    } else if (GSM_EXTENDED.includes(char)) {
      gsmUnits += 2;
    } else {
      isGsm = false;
      break;
    }
  }
  if (isGsm) {
    return {
      encoding: 'gsm7',
      units: gsmUnits,
      // One SMS holds 160. A longer text is split, and each part gives up 7
      // characters to say which part it is.
      segments: gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153),
    };
  }
  // text.length counts 16-bit units, which is what the encoding uses: an
  // emoji outside the basic plane takes two.
  const units = text.length;
  return {
    encoding: 'ucs2',
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
  };
};

// ── Validation ──────────────────────────────────────────────────────────────

const validateEmail = (message: EmailMessage): Result<EmailMessage> => {
  const to = parseEmailAddress(message.to);
  if (!to.ok) return to;
  if (!isFilled(message.subject)) return err(invalid('the subject is empty'));
  if (message.subject.length > SUBJECT_MAX) {
    return err(invalid('the subject is too long'));
  }
  // A line break in a subject would let its text add mail headers.
  if (hasLineBreak(message.subject)) {
    return err(invalid('the subject contains a line break'));
  }
  if (!isFilled(message.text)) return err(invalid('the text body is empty'));
  if (message.html !== undefined && !isFilled(message.html)) {
    return err(invalid('the HTML body is empty'));
  }
  if (
    message.text.length > EMAIL_BODY_MAX ||
    (message.html?.length ?? 0) > EMAIL_BODY_MAX
  ) {
    return err(invalid('the body is too large'));
  }
  return ok({ ...message, to: to.value, subject: message.subject.trim() });
};

const validateSms = (message: SmsMessage): Result<SmsMessage> => {
  const to = parsePhoneNumber(message.to);
  if (!to.ok) return to;
  if (!isFilled(message.text)) return err(invalid('the text is empty'));
  if (smsLength(message.text).segments > SMS_MAX_SEGMENTS) {
    return err(invalid(`the text is longer than ${SMS_MAX_SEGMENTS} SMS`));
  }
  return ok({ ...message, to: to.value });
};

const validateWhatsApp = (
  message: WhatsAppMessage,
): Result<WhatsAppMessage> => {
  const to = parsePhoneNumber(message.to);
  if (!to.ok) return to;
  if (
    typeof message.template !== 'string' ||
    !TEMPLATE_NAME.test(message.template)
  ) {
    return err(invalid('the template name is not valid'));
  }
  if (
    typeof message.language !== 'string' ||
    !LANGUAGE.test(message.language)
  ) {
    return err(invalid('the language is not valid'));
  }
  const parameters = message.parameters;
  if (!Array.isArray(parameters) || parameters.length > PARAMETERS_MAX) {
    return err(invalid('there are too many template parameters'));
  }
  for (const parameter of parameters) {
    if (!isFilled(parameter) || parameter.length > PARAMETER_MAX) {
      return err(invalid('a template parameter is empty or too long'));
    }
    // WhatsApp refuses parameters with line breaks or tabs.
    if (/[\r\n\t]/.test(parameter)) {
      return err(
        invalid('a template parameter contains a line break or a tab'),
      );
    }
  }
  return ok({ ...message, to: to.value });
};

/**
 * Checks a message against the rules of its channel and returns it with its
 * address normalised. Errors never quote the address or the content.
 */
export const validateMessage = <Message extends OutgoingMessage>(
  message: Message,
): Result<Message> => {
  switch (message?.channel) {
    case 'email':
      return validateEmail(message) as Result<Message>;
    case 'sms':
      return validateSms(message) as Result<Message>;
    case 'whatsapp':
      return validateWhatsApp(message) as Result<Message>;
    default:
      return err(invalid('the channel is not known'));
  }
};

/** The channel of a message, for routing and for logs. */
export const channelOf = (message: OutgoingMessage): Channel => message.channel;
