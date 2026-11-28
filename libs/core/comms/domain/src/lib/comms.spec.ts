import { isDomainError, type Result } from '@hk/platform/universal';
import {
  maskEmail,
  maskPhone,
  parseEmailAddress,
  parsePhoneNumber,
} from './address';
import {
  CHANNELS,
  COMMS_ERRORS,
  commsError,
  isCommsErrorCode,
  retryAdviceOf,
  type CommsErrorCode,
} from './errors';
import {
  SMS_MAX_SEGMENTS,
  channelOf,
  smsLength,
  validateMessage,
  type EmailMessage,
  type OutgoingMessage,
  type SmsMessage,
  type WhatsAppMessage,
} from './message';

// Every address in this file is invented. The phone numbers use ranges no
// subscriber holds, and the email domains are reserved for examples.

const valueOf = (result: Result<string>) => (result.ok ? result.value : null);
const codeOf = (result: Result<unknown>) =>
  result.ok ? null : result.error.code;

const email = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  channel: 'email',
  to: 'owner@example.com',
  subject: 'Your invoice',
  text: 'Please find your invoice attached.',
  ...overrides,
});

const sms = (overrides: Partial<SmsMessage> = {}): SmsMessage => ({
  channel: 'sms',
  to: '+237600000001',
  text: 'Your code is 123456',
  ...overrides,
});

const whatsapp = (
  overrides: Partial<WhatsAppMessage> = {},
): WhatsAppMessage => ({
  channel: 'whatsapp',
  to: '+971500000001',
  template: 'otp_code',
  language: 'en',
  parameters: ['123456'],
  ...overrides,
});

describe('email addresses', () => {
  it.each([
    ['owner@example.com', 'owner@example.com'],
    ['  owner@example.com  ', 'owner@example.com'],
    ['Owner@Example.COM', 'Owner@example.com'],
    ['first.last+tag@sub.example.org', 'first.last+tag@sub.example.org'],
    ["o'brien@example.com", "o'brien@example.com"],
    ['a@b.co', 'a@b.co'],
    ['user_name-1@my-shop.example', 'user_name-1@my-shop.example'],
  ])('accepts "%s" as %s', (input, expected) => {
    expect(valueOf(parseEmailAddress(input))).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['owner', 'no @'],
    ['@example.com', 'nothing before the @'],
    ['owner@', 'nothing after the @'],
    ['owner@example', 'a domain with no dot'],
    ['owner@.example.com', 'a domain starting with a dot'],
    ['owner@example..com', 'two dots together in the domain'],
    ['owner..name@example.com', 'two dots together before the @'],
    ['.owner@example.com', 'a leading dot'],
    ['owner.@example.com', 'a trailing dot'],
    ['owner name@example.com', 'a space'],
    ['owner@exa mple.com', 'a space in the domain'],
    ['owner@-example.com', 'a domain label starting with a dash'],
    ['owner@example.com\nBcc: x@example.org', 'a line break'],
    ['owner@example.com,other@example.com', 'two addresses'],
    ['<owner@example.com>', 'angle brackets'],
    [`${'a'.repeat(65)}@example.com`, 'a local part over 64 characters'],
    [`owner@${'a'.repeat(250)}.com`, 'an address over 254 characters'],
    ['ownér@example.com', 'an accented letter before the @'],
  ])('rejects "%s" (%s)', (input) => {
    expect(codeOf(parseEmailAddress(input))).toBe(COMMS_ERRORS.ADDRESS_INVALID);
  });

  it('rejects anything that is not a string', () => {
    for (const input of [undefined, null, 42, {}, ['a@b.co']]) {
      expect(codeOf(parseEmailAddress(input))).toBe(
        COMMS_ERRORS.ADDRESS_INVALID,
      );
    }
  });

  it('never quotes the address in its error', () => {
    const result = parseEmailAddress('secret.person@@example.com');
    expect(!result.ok && JSON.stringify(result.error.toJSON())).not.toContain(
      'secret',
    );
  });
});

describe('phone numbers', () => {
  it.each([
    ['+237600000001', '+237600000001'],
    ['+237 6 00 00 00 01', '+237600000001'],
    ['+237-600-000-001', '+237600000001'],
    ['+237 (600) 000.001', '+237600000001'],
    ['  +971500000001 ', '+971500000001'],
    ['+12025550100', '+12025550100'],
    // A Cameroon landline, an Ivorian number (ten digits) and a French mobile.
    ['+237222000001', '+237222000001'],
    ['+2250700000001', '+2250700000001'],
    ['+33 6 12 34 56 78', '+33612345678'],
  ])('accepts "%s" as %s', (input, expected) => {
    expect(valueOf(parsePhoneNumber(input))).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['600000001', 'no country code'],
    ['00237600000001', 'a 00 prefix'],
    ['237600000001', 'no plus sign'],
    ['+0237600000001', 'a country code starting with zero'],
    ['+1234567', 'seven digits'],
    ['+1234567890123456', 'sixteen digits'],
    ['+237 6OO OOO OO1', 'letters'],
    ['+237600000001;ext=5', 'an extension'],
    ['++237600000001', 'two plus signs'],
    ['+237600000001\n+237600000002', 'two numbers'],
    ['+٢٣٧٦٠٠٠٠٠٠٠١', 'Arabic-Indic digits'],
    // The right shape, but not a number its country could have issued.
    ['+999123456789', 'a country code that does not exist'],
    ['+237999999999', 'Cameroon digits no Cameroon number starts with'],
    ['+2376000000', 'too short for Cameroon'],
    ['+23760000000123', 'too long for Cameroon'],
    ['+9715000000', 'too short for the UAE'],
    ['+1202555010', 'too short for North America'],
    ['+123456789012345', 'fifteen digits that fit no country'],
  ])('rejects "%s" (%s)', (input) => {
    expect(codeOf(parsePhoneNumber(input))).toBe(COMMS_ERRORS.ADDRESS_INVALID);
  });

  it('never quotes a number its country could not have issued', () => {
    const result = parsePhoneNumber('+237999999123');
    expect(!result.ok && JSON.stringify(result.error.toJSON())).not.toContain(
      '999999',
    );
  });

  it('never quotes the number in its error', () => {
    const result = parsePhoneNumber('+237600000001x');
    expect(!result.ok && JSON.stringify(result.error.toJSON())).not.toContain(
      '600000001',
    );
  });
});

describe('masking', () => {
  it('hides most of an email address and keeps the domain', () => {
    expect(maskEmail('owner@example.com')).toBe('o•••@example.com');
    expect(maskEmail('a@b.co')).toBe('a•••@b.co');
    expect(maskEmail('owner@example.com')).not.toContain('owner');
  });

  it('gives nothing away for something that is not an address', () => {
    expect(maskEmail('not-an-address')).toBe('•••');
    expect(maskEmail('@example.com')).toBe('•••');
  });

  it('hides the middle of a phone number', () => {
    expect(maskPhone('+237600000001')).toBe('+237•••••001');
    expect(maskPhone('+971500000001')).toBe('+971•••••001');
    expect(maskPhone('+237600000001')).not.toContain('600000');
  });

  it('gives nothing away for a number too short to mask', () => {
    expect(maskPhone('+12345')).toBe('•••••');
    expect(maskPhone('')).toBe('•••••');
  });

  it('masks every number to the same length, so the length says nothing', () => {
    expect(maskPhone('+12025550100')).toHaveLength(
      maskPhone('+123456789012345').length,
    );
  });
});

describe('SMS length', () => {
  it.each<[string, string, 'gsm7' | 'ucs2', number, number]>([
    ['an empty text', '', 'gsm7', 0, 1],
    ['a short text', 'Your code is 123456', 'gsm7', 19, 1],
    ['exactly one SMS', 'a'.repeat(160), 'gsm7', 160, 1],
    ['one character over', 'a'.repeat(161), 'gsm7', 161, 2],
    ['exactly two SMS', 'a'.repeat(306), 'gsm7', 306, 2],
    ['one over two SMS', 'a'.repeat(307), 'gsm7', 307, 3],
    [
      'French with ç, which GSM lacks in lower case',
      'Reçu payé à Yaoundé',
      'ucs2',
      19,
      1,
    ],
    ['French with ô, which GSM lacks', 'été à côté', 'ucs2', 10, 1],
    ['é è ù à, which GSM has', 'éèùà', 'gsm7', 4, 1],
    ['the euro sign, which counts double', '€', 'gsm7', 2, 1],
    ['brackets, which count double', '[ok]', 'gsm7', 6, 1],
    ['Arabic', 'مرحبا', 'ucs2', 5, 1],
    ['exactly one SMS in Arabic', 'م'.repeat(70), 'ucs2', 70, 1],
    ['one over in Arabic', 'م'.repeat(71), 'ucs2', 71, 2],
    ['an emoji, which takes two units', '😀', 'ucs2', 2, 1],
    ['a line break', 'a\nb', 'gsm7', 3, 1],
  ])('%s', (_name, text, encoding, units, segments) => {
    expect(smsLength(text)).toEqual({ encoding, units, segments });
  });

  it('switches the whole text to 16 bits for one character outside GSM', () => {
    const plain = 'a'.repeat(100);
    expect(smsLength(plain).segments).toBe(1);
    // ç is not in the GSM alphabet (Ç is), so 100 characters no longer fit.
    expect(smsLength(`${plain}ç`)).toEqual({
      encoding: 'ucs2',
      units: 101,
      segments: 2,
    });
  });
});

describe('validateMessage', () => {
  it('accepts a valid message on each channel and normalises the address', () => {
    const mail = validateMessage(email({ to: ' Owner@Example.COM ' }));
    expect(mail.ok && mail.value.to).toBe('Owner@example.com');
    const text = validateMessage(sms({ to: '+237 600 000 001' }));
    expect(text.ok && text.value.to).toBe('+237600000001');
    const chat = validateMessage(whatsapp({ to: '+971-500-000-001' }));
    expect(chat.ok && chat.value.to).toBe('+971500000001');
  });

  it('keeps everything else of the message as it was', () => {
    const message = email({ html: '<p>Hello</p>', sensitive: true });
    const result = validateMessage(message);
    expect(result.ok && result.value).toEqual(message);
  });

  it('trims the subject', () => {
    const result = validateMessage(email({ subject: '  Your invoice  ' }));
    expect(result.ok && result.value.subject).toBe('Your invoice');
  });

  it.each<[string, OutgoingMessage, string]>([
    [
      'an email to a bad address',
      email({ to: 'nobody' }),
      COMMS_ERRORS.ADDRESS_INVALID,
    ],
    [
      'an SMS to a bad number',
      sms({ to: '600000001' }),
      COMMS_ERRORS.ADDRESS_INVALID,
    ],
    [
      'a WhatsApp message to a bad number',
      whatsapp({ to: 'owner@example.com' }),
      COMMS_ERRORS.ADDRESS_INVALID,
    ],
    [
      'an email to a phone number',
      email({ to: '+237600000001' }),
      COMMS_ERRORS.ADDRESS_INVALID,
    ],
    [
      'an SMS to an email address',
      sms({ to: 'owner@example.com' }),
      COMMS_ERRORS.ADDRESS_INVALID,
    ],
  ])('refuses %s', (_name, message, code) => {
    expect(codeOf(validateMessage(message))).toBe(code);
  });

  it.each<[string, OutgoingMessage]>([
    ['an email with no subject', email({ subject: '  ' })],
    [
      'an email with a subject over 200 characters',
      email({ subject: 'x'.repeat(201) }),
    ],
    [
      'an email whose subject would add a header',
      email({ subject: 'Hello\r\nBcc: everyone@example.org' }),
    ],
    [
      'an email whose subject has a bare line feed',
      email({ subject: 'Hello\nWorld' }),
    ],
    ['an email with no text body', email({ text: '' })],
    ['an email with an empty HTML body', email({ html: ' ' })],
    ['an email with a huge body', email({ text: 'x'.repeat(500_001) })],
    ['an SMS with no text', sms({ text: '   ' })],
    ['an SMS longer than four messages', sms({ text: 'a'.repeat(613) })],
    ['a WhatsApp message with no template', whatsapp({ template: '' })],
    ['a template name in capitals', whatsapp({ template: 'OTP Code' })],
    ['a template name with a path in it', whatsapp({ template: '../otp' })],
    ['a language that is not a code', whatsapp({ language: 'english' })],
    ['an empty template parameter', whatsapp({ parameters: ['123456', ''] })],
    [
      'a template parameter with a line break',
      whatsapp({ parameters: ['a\nb'] }),
    ],
    ['a template parameter with a tab', whatsapp({ parameters: ['a\tb'] })],
    [
      'too many template parameters',
      whatsapp({ parameters: Array.from({ length: 21 }, () => 'x') }),
    ],
    [
      'a template parameter that is too long',
      whatsapp({ parameters: ['x'.repeat(1025)] }),
    ],
    [
      'parameters that are not a list',
      whatsapp({ parameters: 'x' as unknown as string[] }),
    ],
    [
      'an unknown channel',
      { ...sms(), channel: 'fax' } as unknown as OutgoingMessage,
    ],
    ['nothing at all', undefined as unknown as OutgoingMessage],
  ])('refuses %s', (_name, message) => {
    expect(codeOf(validateMessage(message))).toBe(COMMS_ERRORS.MESSAGE_INVALID);
  });

  it('accepts an SMS of exactly the longest length', () => {
    const longest = 'a'.repeat(153 * SMS_MAX_SEGMENTS);
    expect(validateMessage(sms({ text: longest })).ok).toBe(true);
    expect(codeOf(validateMessage(sms({ text: `${longest}a` })))).toBe(
      COMMS_ERRORS.MESSAGE_INVALID,
    );
  });

  it('accepts a template with no parameters, and a regional language', () => {
    expect(
      validateMessage(whatsapp({ parameters: [], language: 'fr_CM' })).ok,
    ).toBe(true);
  });

  it('never quotes the address or the content in an error', () => {
    const results = [
      validateMessage(sms({ to: '+237600000001999999', text: 'code 424242' })),
      validateMessage(
        email({ subject: 'secret-subject\nx', text: 'secret-body' }),
      ),
      validateMessage(whatsapp({ parameters: ['secret\nparam'] })),
    ];
    for (const result of results) {
      const text = result.ok ? '' : JSON.stringify(result.error.toJSON());
      expect(text).not.toMatch(/600000001|424242|secret/);
    }
  });

  it('tells the channel of a message', () => {
    expect(channelOf(email())).toBe('email');
    expect(channelOf(sms())).toBe('sms');
    expect(channelOf(whatsapp())).toBe('whatsapp');
    expect(CHANNELS).toEqual(['email', 'sms', 'whatsapp']);
  });
});

describe('comms errors', () => {
  it.each<[CommsErrorCode, string]>([
    [COMMS_ERRORS.ADDRESS_INVALID, 'never'],
    [COMMS_ERRORS.MESSAGE_INVALID, 'never'],
    [COMMS_ERRORS.CHANNEL_UNAVAILABLE, 'never'],
    [COMMS_ERRORS.PROVIDER_REJECTED, 'never'],
    [COMMS_ERRORS.PROVIDER_UNAVAILABLE, 'later'],
    [COMMS_ERRORS.DELIVERY_UNKNOWN, 'unknown'],
  ])('%s is retried: %s', (code, advice) => {
    const error = commsError(code, 'sms');
    expect(isDomainError(error)).toBe(true);
    expect(error.code).toBe(code);
    expect(error.details).toEqual({ channel: 'sms', retry: advice });
    expect(retryAdviceOf(error)).toBe(advice);
  });

  it('carries a provider reason code when given one', () => {
    const cause = new Error('HTTP 400');
    const error = commsError(COMMS_ERRORS.PROVIDER_REJECTED, 'whatsapp', {
      reason: 'template_not_approved',
      cause,
    });
    expect(error.details).toEqual({
      channel: 'whatsapp',
      retry: 'never',
      reason: 'template_not_approved',
    });
    expect(error.cause).toBe(cause);
  });

  it('treats an error it does not know as "may have been sent"', () => {
    // The cautious answer: an unknown failure must not be retried blindly.
    expect(retryAdviceOf(new Error('socket hang up'))).toBe('unknown');
    expect(retryAdviceOf(undefined)).toBe('unknown');
    expect(retryAdviceOf({ code: 'SOMETHING_ELSE' })).toBe('unknown');
  });

  it('knows its own codes', () => {
    expect(isCommsErrorCode('COMMS_DELIVERY_UNKNOWN')).toBe(true);
    expect(isCommsErrorCode('ROW_NOT_FOUND')).toBe(false);
    expect(isCommsErrorCode(undefined)).toBe(false);
  });
});
