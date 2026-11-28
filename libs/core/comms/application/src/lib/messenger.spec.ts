import {
  COMMS_ERRORS,
  commsError,
  type EmailMessage,
  type OutgoingMessage,
  type SmsMessage,
  type WhatsAppMessage,
} from '@hk/core/comms/domain';
import { FixedClock, isDomainError } from '@hk/platform/universal';
import {
  messageSenderConformance,
  type MessageSenderSubject,
} from './conformance';
import {
  FakeSender,
  createFakeEmailSender,
  createFakeSmsSender,
  createFakeWhatsAppSender,
} from './fakes';
import { COMMS_USE_CASES, createMessenger } from './messenger';
import type { MessageSender, SendReceipt } from './ports';

// Every address in this file is invented.

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
  text: 'Your code is 424242',
  ...overrides,
});

const whatsapp = (
  overrides: Partial<WhatsAppMessage> = {},
): WhatsAppMessage => ({
  channel: 'whatsapp',
  to: '+237600000001',
  template: 'otp_code',
  language: 'fr',
  parameters: ['424242'],
  ...overrides,
});

const codeOfRejection = async (
  action: () => Promise<unknown>,
): Promise<string> => {
  try {
    await action();
  } catch (error) {
    return isDomainError(error)
      ? error.code
      : `not a DomainError: ${String(error)}`;
  }
  return 'nothing was thrown';
};

describe('messenger', () => {
  const clock = new FixedClock('2026-11-28T09:00:00.000Z');
  let emailSender: FakeSender<EmailMessage>;
  let smsSender: FakeSender<SmsMessage>;
  let whatsappSender: FakeSender<WhatsAppMessage>;

  const build = () =>
    createMessenger({
      email: emailSender,
      sms: smsSender,
      whatsapp: whatsappSender,
    });

  beforeEach(() => {
    emailSender = createFakeEmailSender(clock);
    smsSender = createFakeSmsSender(clock);
    whatsappSender = createFakeWhatsAppSender(clock);
  });

  it('declares that no comms use case runs offline', () => {
    expect(COMMS_USE_CASES).toEqual({
      send: { name: 'core.comms.send', offline: false },
      sendFirst: { name: 'core.comms.send_first', offline: false },
    });
  });

  describe('send', () => {
    it('routes each message to the sender of its channel', async () => {
      const messenger = build();
      const receipts = [
        await messenger.send(email()),
        await messenger.send(sms()),
        await messenger.send(whatsapp()),
      ];
      expect(receipts).toEqual([
        {
          channel: 'email',
          providerMessageId: 'fake-email-1',
          acceptedAt: '2026-11-28T09:00:00.000Z',
        },
        {
          channel: 'sms',
          providerMessageId: 'fake-sms-1',
          acceptedAt: '2026-11-28T09:00:00.000Z',
        },
        {
          channel: 'whatsapp',
          providerMessageId: 'fake-whatsapp-1',
          acceptedAt: '2026-11-28T09:00:00.000Z',
        },
      ]);
      expect(emailSender.sent).toHaveLength(1);
      expect(smsSender.sent).toHaveLength(1);
      expect(whatsappSender.sent).toHaveLength(1);
    });

    it('hands the sender the message with its address normalised', async () => {
      await build().send(sms({ to: '+237 600 000 001' }));
      expect(smsSender.last()?.to).toBe('+237600000001');
    });

    it('refuses an invalid message before any sender sees it', async () => {
      const messenger = build();
      expect(
        await codeOfRejection(() => messenger.send(sms({ to: '6000' }))),
      ).toBe(COMMS_ERRORS.ADDRESS_INVALID);
      expect(
        await codeOfRejection(() => messenger.send(sms({ text: '' }))),
      ).toBe(COMMS_ERRORS.MESSAGE_INVALID);
      expect(smsSender.sent).toEqual([]);
    });

    it('says a channel is unavailable when it has no sender', async () => {
      const messenger = createMessenger({ email: emailSender });
      expect(messenger.channels()).toEqual(['email']);
      let error: unknown;
      try {
        await messenger.send(sms());
      } catch (caught) {
        error = caught;
      }
      expect(isDomainError(error) && error.code).toBe(
        COMMS_ERRORS.CHANNEL_UNAVAILABLE,
      );
      expect(isDomainError(error) && error.details).toEqual({
        channel: 'sms',
        retry: 'never',
      });
    });

    it('lists the channels that are set up', () => {
      expect(build().channels().sort()).toEqual(['email', 'sms', 'whatsapp']);
      expect(createMessenger({}).channels()).toEqual([]);
    });

    it.each([
      ['rejected', COMMS_ERRORS.PROVIDER_REJECTED],
      ['unavailable', COMMS_ERRORS.PROVIDER_UNAVAILABLE],
      ['timeout', COMMS_ERRORS.DELIVERY_UNKNOWN],
    ] as const)('passes on a sender failure: %s', async (failure, code) => {
      smsSender.failNext(failure);
      expect(await codeOfRejection(() => build().send(sms()))).toBe(code);
    });

    it('reports a sender that throws something else as "may have been sent"', async () => {
      const cause = new Error('socket hang up');
      const broken: MessageSender<SmsMessage> = {
        channel: 'sms',
        send: async () => {
          throw cause;
        },
      };
      let error: unknown;
      try {
        await createMessenger({ sms: broken }).send(sms());
      } catch (caught) {
        error = caught;
      }
      expect(isDomainError(error) && error.code).toBe(
        COMMS_ERRORS.DELIVERY_UNKNOWN,
      );
      expect(isDomainError(error) && error.cause).toBe(cause);
    });

    it('never puts the address or the content in what it throws', async () => {
      const messenger = build();
      const failures: unknown[] = [];
      const attempt = async (message: OutgoingMessage) => {
        try {
          await messenger.send(message);
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(sms({ to: '+237600000001999999' }));
      await attempt(sms({ text: `424242 ${'x'.repeat(700)}` }));
      for (const failure of ['rejected', 'unavailable', 'timeout'] as const) {
        smsSender.failNext(failure);
        await attempt(sms());
      }
      expect(failures).toHaveLength(5);
      for (const failure of failures) {
        const text = isDomainError(failure)
          ? `${failure.message} ${JSON.stringify(failure.toJSON())}`
          : String(failure);
        expect(text).not.toMatch(/600000001|424242/);
      }
    });
  });

  describe('sendFirst', () => {
    const otp: OutgoingMessage[] = [whatsapp(), sms()];

    it('stops at the first channel that accepts', async () => {
      const outcome = await build().sendFirst(otp);
      expect(outcome).toEqual({
        delivered: true,
        receipt: {
          channel: 'whatsapp',
          providerMessageId: 'fake-whatsapp-1',
          acceptedAt: '2026-11-28T09:00:00.000Z',
        },
        attempts: [{ channel: 'whatsapp', outcome: 'accepted' }],
      });
      expect(smsSender.sent).toEqual([]);
    });

    it.each(['rejected', 'unavailable'] as const)(
      'falls back to the next channel when the first is %s',
      async (failure) => {
        whatsappSender.failNext(failure);
        const outcome = await build().sendFirst(otp);
        expect(outcome.delivered).toBe(true);
        expect(outcome.attempts.map((attempt) => attempt.outcome)).toEqual([
          failure === 'rejected'
            ? COMMS_ERRORS.PROVIDER_REJECTED
            : COMMS_ERRORS.PROVIDER_UNAVAILABLE,
          'accepted',
        ]);
        expect(smsSender.sent).toHaveLength(1);
      },
    );

    it('falls back when a channel is not set up', async () => {
      const outcome = await createMessenger({ sms: smsSender }).sendFirst(otp);
      expect(outcome.delivered).toBe(true);
      expect(outcome.attempts).toEqual([
        {
          channel: 'whatsapp',
          outcome: COMMS_ERRORS.CHANNEL_UNAVAILABLE,
          retry: 'never',
        },
        { channel: 'sms', outcome: 'accepted' },
      ]);
    });

    it('does not fall back after a timeout, so nobody gets the message twice', async () => {
      whatsappSender.failNext('timeout');
      const outcome = await build().sendFirst(otp);
      expect(outcome.delivered).toBe(false);
      expect(outcome.attempts).toEqual([
        {
          channel: 'whatsapp',
          outcome: COMMS_ERRORS.DELIVERY_UNKNOWN,
          retry: 'unknown',
        },
      ]);
      expect(!outcome.delivered && outcome.error.code).toBe(
        COMMS_ERRORS.DELIVERY_UNKNOWN,
      );
      expect(smsSender.sent).toEqual([]);
    });

    it('falls back after a timeout when told a second copy is harmless', async () => {
      whatsappSender.failNext('timeout');
      const outcome = await build().sendFirst(otp, { onUnknown: 'continue' });
      expect(outcome.delivered).toBe(true);
      expect(outcome.attempts.map((attempt) => attempt.channel)).toEqual([
        'whatsapp',
        'sms',
      ]);
    });

    it('reports every attempt when all fail, with the last error', async () => {
      whatsappSender.failNext('rejected');
      smsSender.failNext('unavailable');
      const outcome = await build().sendFirst(otp);
      expect(outcome.delivered).toBe(false);
      expect(outcome.attempts).toEqual([
        {
          channel: 'whatsapp',
          outcome: COMMS_ERRORS.PROVIDER_REJECTED,
          retry: 'never',
        },
        {
          channel: 'sms',
          outcome: COMMS_ERRORS.PROVIDER_UNAVAILABLE,
          retry: 'later',
        },
      ]);
      expect(!outcome.delivered && outcome.error.code).toBe(
        COMMS_ERRORS.PROVIDER_UNAVAILABLE,
      );
    });

    it('skips an invalid message and tries the next', async () => {
      const outcome = await build().sendFirst([
        whatsapp({ to: 'not-a-number' }),
        sms(),
      ]);
      expect(outcome.delivered).toBe(true);
      expect(outcome.attempts[0]).toEqual({
        channel: 'whatsapp',
        outcome: COMMS_ERRORS.ADDRESS_INVALID,
        retry: 'never',
      });
    });

    it('delivers nothing, without throwing, when given no messages', async () => {
      const outcome = await build().sendFirst([]);
      expect(outcome.delivered).toBe(false);
      expect(outcome.attempts).toEqual([]);
      expect(!outcome.delivered && outcome.error.code).toBe(
        COMMS_ERRORS.MESSAGE_INVALID,
      );
    });
  });
});

describe('fake senders', () => {
  it('keep what they accepted, in order', async () => {
    const sender = createFakeSmsSender();
    await sender.send(sms({ text: 'first' }));
    await sender.send(sms({ text: 'second' }));
    expect(sender.sent.map((message) => message.text)).toEqual([
      'first',
      'second',
    ]);
    expect(sender.last()?.text).toBe('second');
  });

  it('do not keep a message they failed to send', async () => {
    const sender = createFakeSmsSender();
    sender.failNext('rejected');
    await expect(sender.send(sms())).rejects.toMatchObject({
      code: COMMS_ERRORS.PROVIDER_REJECTED,
    });
    expect(sender.sent).toEqual([]);
  });

  it('fail as many times as asked, then recover', async () => {
    const sender = createFakeSmsSender();
    sender.failNext('unavailable', 2);
    await expect(sender.send(sms())).rejects.toBeDefined();
    await expect(sender.send(sms())).rejects.toBeDefined();
    await expect(sender.send(sms())).resolves.toMatchObject({ channel: 'sms' });
  });

  it('refuse a message for another channel', async () => {
    const sender = createFakeSmsSender();
    await expect(
      sender.send(email() as unknown as SmsMessage),
    ).rejects.toMatchObject({ code: COMMS_ERRORS.MESSAGE_INVALID });
  });

  it('forget everything on reset', async () => {
    const sender = createFakeSmsSender();
    await sender.send(sms());
    sender.failNext('timeout');
    sender.reset();
    expect(sender.sent).toEqual([]);
    expect(sender.last()).toBeUndefined();
    await expect(sender.send(sms())).resolves.toBeDefined();
  });
});

// ── Conformance ─────────────────────────────────────────────────────────────

const ADDRESS_SECRET = '600000001';
const CONTENT_SECRET = 'TOP-SECRET-424242';

const subjects = {
  email: (sender: FakeSender<EmailMessage>): MessageSenderSubject => ({
    sender,
    validMessage: () => email({ text: CONTENT_SECRET }),
    messageToBadAddress: () =>
      email({ to: `owner-${ADDRESS_SECRET}@@example.com` }),
    messageWithBadContent: () =>
      email({ subject: `${CONTENT_SECRET}\r\nBcc: x@example.org` }),
    induce: (failure) => sender.failNext(failure),
    providerReceived: () => sender.sent.length,
    secrets: () => [ADDRESS_SECRET, CONTENT_SECRET, 'owner@example.com'],
  }),
  sms: (sender: FakeSender<SmsMessage>): MessageSenderSubject => ({
    sender,
    validMessage: () => sms({ text: CONTENT_SECRET }),
    messageToBadAddress: () => sms({ to: `+237${ADDRESS_SECRET}99999999` }),
    messageWithBadContent: () =>
      sms({ text: `${CONTENT_SECRET} ${'x'.repeat(700)}` }),
    induce: (failure) => sender.failNext(failure),
    providerReceived: () => sender.sent.length,
    secrets: () => [ADDRESS_SECRET, CONTENT_SECRET],
  }),
  whatsapp: (sender: FakeSender<WhatsAppMessage>): MessageSenderSubject => ({
    sender,
    validMessage: () => whatsapp({ parameters: [CONTENT_SECRET] }),
    messageToBadAddress: () => whatsapp({ to: `237${ADDRESS_SECRET}` }),
    messageWithBadContent: () =>
      whatsapp({ parameters: [`${CONTENT_SECRET}\nsecond line`] }),
    induce: (failure) => sender.failNext(failure),
    providerReceived: () => sender.sent.length,
    secrets: () => [ADDRESS_SECRET, CONTENT_SECRET],
  }),
};

describe('fake email sender conformance', () => {
  for (const testCase of messageSenderConformance) {
    it(testCase.name, () =>
      testCase.run(subjects.email(createFakeEmailSender())),
    );
  }
});

describe('fake SMS sender conformance', () => {
  for (const testCase of messageSenderConformance) {
    it(testCase.name, () => testCase.run(subjects.sms(createFakeSmsSender())));
  }
});

describe('fake WhatsApp sender conformance', () => {
  for (const testCase of messageSenderConformance) {
    it(testCase.name, () =>
      testCase.run(subjects.whatsapp(createFakeWhatsAppSender())),
    );
  }
});

describe('the sender conformance suite notices a sender that', () => {
  /** Names of the cases a broken SMS sender fails. Each case gets a new one. */
  const run = async (
    wrap: (
      inner: FakeSender<SmsMessage>,
    ) => (message: SmsMessage) => Promise<SendReceipt>,
  ): Promise<string[]> => {
    const failed: string[] = [];
    for (const testCase of messageSenderConformance) {
      const inner = createFakeSmsSender();
      const send = wrap(inner);
      const sender: MessageSender<SmsMessage> = { channel: 'sms', send };
      try {
        await testCase.run({ ...subjects.sms(inner), sender });
      } catch {
        failed.push(testCase.name);
      }
    }
    return failed;
  };

  it('is sound: an honest sender fails nothing', async () => {
    expect(await run((inner) => (message) => inner.send(message))).toEqual([]);
  });

  it('reports a timeout as a plain failure', async () => {
    const failed = await run((inner) => async (message) => {
      try {
        return await inner.send(message);
      } catch (error) {
        if (
          isDomainError(error) &&
          error.code === COMMS_ERRORS.DELIVERY_UNKNOWN
        ) {
          throw commsError(COMMS_ERRORS.PROVIDER_REJECTED, 'sms');
        }
        throw error;
      }
    });
    expect(failed).toEqual(['reports a timeout as unknown, never as failed']);
  });

  it('reports a timeout as worth retrying', async () => {
    const failed = await run((inner) => async (message) => {
      try {
        return await inner.send(message);
      } catch (error) {
        if (
          isDomainError(error) &&
          error.code === COMMS_ERRORS.DELIVERY_UNKNOWN
        ) {
          throw commsError(COMMS_ERRORS.PROVIDER_UNAVAILABLE, 'sms');
        }
        throw error;
      }
    });
    expect(failed).toEqual(['reports a timeout as unknown, never as failed']);
  });

  it('sends to a malformed address anyway', async () => {
    const failed = await run((inner) => async (message) => {
      try {
        return await inner.send(message);
      } catch (error) {
        if (
          isDomainError(error) &&
          error.code === COMMS_ERRORS.ADDRESS_INVALID
        ) {
          return inner.send({ ...message, to: '+237600000002' });
        }
        throw error;
      }
    });
    expect(failed).toEqual([
      'refuses a malformed address without contacting the provider',
      'never puts the address or the content in an error',
    ]);
  });

  it('throws plain errors', async () => {
    const failed = await run((inner) => async (message) => {
      try {
        return await inner.send(message);
      } catch (error) {
        throw new Error(isDomainError(error) ? error.code : 'failed', {
          cause: error,
        });
      }
    });
    expect(failed).toEqual([
      'refuses a malformed address without contacting the provider',
      'refuses content the channel does not allow without contacting the provider',
      'reports a refusal by the provider as final',
      'reports an unreachable provider as worth retrying later',
      'reports a timeout as unknown, never as failed',
    ]);
  });

  it('quotes the phone number in its errors', async () => {
    const failed = await run((inner) => async (message) => {
      try {
        return await inner.send(message);
      } catch (error) {
        if (isDomainError(error)) {
          throw commsError(error.code as 'COMMS_PROVIDER_REJECTED', 'sms', {
            reason: `to ${message.to}`,
          });
        }
        throw error;
      }
    });
    expect(failed).toEqual([
      'never puts the address or the content in an error',
    ]);
  });

  it('quotes the text in its errors', async () => {
    const failed = await run((inner) => async (message) => {
      try {
        return await inner.send(message);
      } catch (error) {
        if (isDomainError(error)) {
          throw commsError(error.code as 'COMMS_PROVIDER_REJECTED', 'sms', {
            reason: message.text.slice(0, 40),
          });
        }
        throw error;
      }
    });
    expect(failed).toEqual([
      'never puts the address or the content in an error',
    ]);
  });

  it('gives every message the same id', async () => {
    const failed = await run((inner) => async (message) => ({
      ...(await inner.send(message)),
      providerMessageId: 'same',
    }));
    expect(failed).toEqual(['gives each message its own provider id']);
  });

  it('returns a receipt without a usable time', async () => {
    const failed = await run((inner) => async (message) => ({
      ...(await inner.send(message)),
      acceptedAt: 'just now',
    }));
    expect(failed).toEqual(['accepts a valid message and returns a receipt']);
  });

  it('says it sent a message it never passed to the provider', async () => {
    const failed = await run(() => async () => ({
      channel: 'sms',
      providerMessageId: `local-${Math.random()}`,
      acceptedAt: '2026-11-28T09:00:00.000Z',
    }));
    expect(failed).toContain('accepts a valid message and returns a receipt');
    expect(failed).toContain(
      'refuses a malformed address without contacting the provider',
    );
  });

  it('stays broken after one failure', async () => {
    const failed = await run((inner) => {
      let broken = false;
      return async (message) => {
        if (broken) throw commsError(COMMS_ERRORS.PROVIDER_UNAVAILABLE, 'sms');
        try {
          return await inner.send(message);
        } catch (error) {
          if (isDomainError(error) && error.details['retry'] !== 'never') {
            broken = true;
          }
          throw error;
        }
      };
    });
    expect(failed).toContain('works again after a failure');
  });
});
