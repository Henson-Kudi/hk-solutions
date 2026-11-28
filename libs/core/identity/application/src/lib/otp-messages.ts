import type { Channel, OutgoingMessage } from '@hk/core/comms/domain';
import type { Identifier, OtpPurpose } from '@hk/core/identity/domain';
import type { Locale } from '@hk/platform/universal';

/**
 * The words of a one-time code message, per language.
 *
 * These live on the server because the server sends them. When the shared
 * i18n catalog exists (client/i18n, plan phase 4) they move into it. Arabic
 * falls back to English until it is written by a speaker.
 *
 * Every message is marked sensitive: its content is a secret and must never
 * be stored or logged.
 */

interface Wording {
  /** SMS text. `{code}`, `{app}` and `{minutes}` are filled in. Kept to one SMS. */
  sms: string;
  emailSubject: string;
  emailText: string;
}

const WORDING: Record<OtpPurpose, Record<'en' | 'fr', Wording>> = {
  verify_identifier: {
    en: {
      sms: '{app}: your verification code is {code}. Valid for {minutes} minutes. Do not share it.',
      emailSubject: '{app}: your verification code',
      emailText:
        'Your verification code is {code}.\n\nIt is valid for {minutes} minutes. Do not share it with anyone.\n\nIf you did not ask for this code, you can ignore this message.',
    },
    fr: {
      sms: '{app} : votre code de vérification est {code}. Valable {minutes} minutes. Ne le partagez pas.',
      emailSubject: '{app} : votre code de vérification',
      emailText:
        "Votre code de vérification est {code}.\n\nIl est valable {minutes} minutes. Ne le partagez avec personne.\n\nSi vous n'avez pas demandé ce code, ignorez ce message.",
    },
  },
  login: {
    en: {
      sms: '{app}: your sign-in code is {code}. Valid for {minutes} minutes. Do not share it.',
      emailSubject: '{app}: your sign-in code',
      emailText:
        'Your sign-in code is {code}.\n\nIt is valid for {minutes} minutes. Do not share it with anyone.\n\nIf you are not trying to sign in, someone else may have typed your address by mistake. You can ignore this message.',
    },
    fr: {
      sms: '{app} : votre code de connexion est {code}. Valable {minutes} minutes. Ne le partagez pas.',
      emailSubject: '{app} : votre code de connexion',
      emailText:
        "Votre code de connexion est {code}.\n\nIl est valable {minutes} minutes. Ne le partagez avec personne.\n\nSi vous n'essayez pas de vous connecter, ignorez ce message.",
    },
  },
  password_reset: {
    en: {
      sms: '{app}: your password reset code is {code}. Valid for {minutes} minutes. Do not share it.',
      emailSubject: '{app}: reset your password',
      emailText:
        'Your password reset code is {code}.\n\nIt is valid for {minutes} minutes. Do not share it with anyone.\n\nIf you did not ask to reset your password, you can ignore this message. Your password has not changed.',
    },
    fr: {
      sms: '{app} : votre code de réinitialisation est {code}. Valable {minutes} minutes. Ne le partagez pas.',
      emailSubject: '{app} : réinitialisez votre mot de passe',
      emailText:
        "Votre code de réinitialisation est {code}.\n\nIl est valable {minutes} minutes. Ne le partagez avec personne.\n\nSi vous n'avez pas demandé à réinitialiser votre mot de passe, ignorez ce message. Votre mot de passe n'a pas changé.",
    },
  },
};

/** The WhatsApp template for each purpose. The template text is approved on WhatsApp's side. */
export const OTP_WHATSAPP_TEMPLATES: Record<OtpPurpose, string> = {
  verify_identifier: 'otp_verification',
  login: 'otp_login',
  password_reset: 'otp_password_reset',
};

const fill = (text: string, values: Record<string, string>): string =>
  text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

export interface OtpMessageInput {
  channel: Channel;
  identifier: Identifier;
  purpose: OtpPurpose;
  code: string;
  locale: Locale;
  /** The product's name, as the person knows it. */
  appName: string;
  minutes: number;
}

/**
 * Builds the message carrying a code on one channel, or null when the
 * channel cannot reach that kind of identifier (an SMS to an email address).
 *
 * The SMS wording uses only characters of the GSM alphabet (é is in it; ç,
 * ê and ô are not). One character outside it would halve how much fits in
 * one SMS. A test checks every wording stays within one SMS.
 */
export const otpMessage = (input: OtpMessageInput): OutgoingMessage | null => {
  const language = input.locale === 'fr' ? 'fr' : 'en';
  const wording = WORDING[input.purpose][language];
  const values = {
    code: input.code,
    app: input.appName,
    minutes: String(input.minutes),
  };
  const { kind, value } = input.identifier;

  if (input.channel === 'email' && kind === 'email') {
    return {
      channel: 'email',
      to: value,
      subject: fill(wording.emailSubject, values),
      text: fill(wording.emailText, values),
      sensitive: true,
    };
  }
  if (input.channel === 'sms' && kind === 'phone') {
    return {
      channel: 'sms',
      to: value,
      text: fill(wording.sms, values),
      sensitive: true,
    };
  }
  if (input.channel === 'whatsapp' && kind === 'phone') {
    return {
      channel: 'whatsapp',
      to: value,
      template: OTP_WHATSAPP_TEMPLATES[input.purpose],
      language,
      parameters: [input.code],
      sensitive: true,
    };
  }
  return null;
};
