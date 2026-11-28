# core/comms

Sending messages to people: email, SMS and WhatsApp, each behind an interface, with fakes for
tests and local development.

| Lib                          | Runs on  | Holds                                                                         |
| ---------------------------- | -------- | ----------------------------------------------------------------------------- |
| `@hk/core/comms/domain`      | anywhere | Addresses, messages and their rules per channel, error codes, masking         |
| `@hk/core/comms/application` | anywhere | The sender ports, `createMessenger`, fake senders, `messageSenderConformance` |

There is no provider adapter yet: none has been chosen. Each one will be its own lib, tagged
`layer:infra-node`, and must pass the conformance suite.

## Sending

```ts
const messenger = createMessenger({ email, sms, whatsapp });

await messenger.send({
  channel: 'email',
  to: 'owner@example.com',
  subject: 'Your invoice',
  text: 'Please find your invoice attached.',
});
```

A message is checked before any provider is contacted: the address, and the rules of its channel.

| Channel    | Address                          | Rules                                                           |
| ---------- | -------------------------------- | --------------------------------------------------------------- |
| `email`    | An email address                 | Subject up to 200 characters, no line breaks; a plain-text body |
| `sms`      | A phone number with country code | At most 4 SMS long                                              |
| `whatsapp` | A phone number with country code | A pre-approved template, its language and its parameters        |

Phone numbers must start with `+` and the country code (`+237...`). There is no default country:
guessing one would send a message to the wrong person. A number must also be one its country
could have issued (a real country code, the right length, the right leading digits); that is
checked with `libphonenumber-js` (`docs/adr/0019`).

## Fallback between channels

```ts
const outcome = await messenger.sendFirst([whatsappMessage, smsMessage], {
  onUnknown: 'continue', // a one-time code: a second copy is harmless
});
if (!outcome.delivered) {
  // outcome.attempts says what happened on each channel
}
```

`sendFirst` tries the messages in order and stops at the first one a provider accepts.

## Failures

`send` rejects with one of six codes, and the error says whether to retry:

| Code                         | Meaning                                     | Retry       |
| ---------------------------- | ------------------------------------------- | ----------- |
| `COMMS_ADDRESS_INVALID`      | The address is malformed. Nothing was sent. | never       |
| `COMMS_MESSAGE_INVALID`      | The message breaks a rule of its channel.   | never       |
| `COMMS_CHANNEL_UNAVAILABLE`  | No sender is set up for the channel.        | never       |
| `COMMS_PROVIDER_REJECTED`    | The provider refused the message.           | never       |
| `COMMS_PROVIDER_UNAVAILABLE` | The provider could not be reached.          | later       |
| `COMMS_DELIVERY_UNKNOWN`     | The provider did not answer in time.        | **unknown** |

**A timeout is never reported as a failure.** The message may have gone out, and a blind retry
would send it twice. `sendFirst` stops at an unknown outcome unless told that a duplicate is
harmless.

A receipt means the provider **accepted** the message, not that it was delivered.

## Privacy

- Phone numbers and email addresses are personal data. **No error contains an address or message
  content**; the conformance suite checks it for every sender.
- Use `maskEmail` and `maskPhone` whenever an address appears in a log or on a screen:
  `o•••@example.com`, `+237•••••001`.
- Mark a message `sensitive: true` when its content must never be stored or logged, such as a
  one-time code.

## In tests and local development

```ts
const sms = createFakeSmsSender();
// ... run the code under test ...
expect(sms.last()?.text).toContain('Your code is');

sms.failNext('timeout'); // make the next send time out
```

Fake senders keep messages in a list and send nothing. They pass the same conformance suite as a
real sender.

## Adding a provider

Implement `MessageSender` for the channel and run `messageSenderConformance` against it, using
the provider's sandbox or a local stand-in, never live delivery.
