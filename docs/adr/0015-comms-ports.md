# ADR 0015: Messaging ports for email, SMS and WhatsApp

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0008 (redaction), ADR 0013 (how core libs are laid out), ADR 0014
  (`layer:infra-node`)

## Context

`core/comms` is the last part of plan row 3.1: "email, SMS, WhatsApp behind ports, with fakes",
done when the "comms conformance suites" exist. No messaging provider has been chosen for either
country.

## Decision

### One sender port per channel, and one conformance suite for all

`MessageSender<Message>` has one method, `send`. Email, SMS and WhatsApp each have their own
message type and their own sender. One suite, `messageSenderConformance`, states what every
sender must do, and each sender runs it. A provider adapter is done when it passes.

This PR has the pure layers only: domain and application. A provider adapter will be its own lib
tagged `layer:infra-node`, added when a provider is chosen.

### A timeout is "unknown", never "failed"

A request that timed out may have been processed. `send` reports it as `COMMS_DELIVERY_UNKNOWN`,
and every error carries retry advice: `never`, `later` or `unknown`. This is the rule the project
already applies to payment providers, applied to messages, where the cost of getting it wrong is
a customer receiving the same reminder twice.

The messenger also maps anything a sender throws that is not a comms error to
`COMMS_DELIVERY_UNKNOWN`: an adapter bug must not be read as "safe to retry".

### Fallback is explicit about duplicates

`sendFirst` tries messages in order and stops at the first accepted one. It falls back on a
refusal, an unreachable provider, a missing channel or an invalid message. On an unknown outcome
it stops, unless the caller passes `onUnknown: 'continue'`. A one-time code wants that: a second
copy is harmless, and none at all locks the person out.

### Messages are checked before a provider is contacted

`validateMessage` applies the channel's rules, so a bad message costs nothing and fails the same
way whoever the provider is. Senders validate too, because they can be called directly.

- **Phone numbers are E.164 with no default country.** A number must start with `+` and its
  country code. Guessing a country sends a message to a stranger.
- **Email subjects may not contain line breaks**, which would let a subject add mail headers.
- **An SMS is at most four segments.** Length is counted the way networks count it: 160
  characters in the GSM alphabet, 70 once any other character appears.
- **WhatsApp messages are templates.** A message a business starts must use a template approved
  by WhatsApp. Free-form replies inside a customer conversation are not modelled yet.

### No address and no content in an error

A phone number, an email address and the text of a one-time code are exactly what must not reach
a log. Errors carry the channel, the retry advice and an optional short reason code. The
conformance suite sends messages with known markers and fails any sender whose errors contain
them. `maskEmail` and `maskPhone` are provided for the places an address must be shown.

### Fakes are full senders

`FakeSender` keeps accepted messages in a list, can be told to fail the next send in each of the
three ways, and passes the conformance suite. Local development and every test use it, so no
message leaves a developer's machine.

## Consequences

- **Nothing can be sent for real yet.** Choosing providers per country is open: an email service,
  an SMS aggregator that reaches Cameroon's networks, and a WhatsApp Business provider.
- **There is no delivery log and no queue.** A caller sends inline and gets the result. Retrying
  `later` failures, recording what was sent to whom, and delivery reports from providers come
  with the worker (row 3.11) and with the first product that sends reminders.
- **The `sensitive` flag has no reader yet.** It is carried on the message for the delivery log
  to honour when it exists.
- **Templates are named, not held.** Which WhatsApp templates exist, their wording per language
  and their approval are outside the code so far.
- **`core/identity` (row 3.2) is the first caller**: one-time codes by WhatsApp, SMS or email.
- **Email validation is deliberately narrow.** Quoted local parts and non-ASCII addresses are
  refused. Both are legal and rare; widen it if a real address is turned away.
