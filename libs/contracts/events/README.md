# @hk/contracts/events

How one service tells the others that something happened.

An event is defined once, here in contracts, with a topic, a version and a Zod schema for its
payload. The producer builds events through the definition and the consumer parses them through the
same definition, so both sides agree on the shape and neither trusts the other's JSON.

```ts
export const invoiceIssued = defineEvent({
  topic: 'sales.invoice.issued',
  version: 1,
  schema: z.object({ invoiceId: uuidSchema, total: moneySchema }),
});
```

**Producer**, inside the transaction that makes the change:

```ts
await outbox.append(transaction, invoiceIssued.create({ invoiceId, total: total.toJSON() }));
```

`create` throws if the payload does not match the schema: a producer never emits an event its own
definition rejects.

**Consumer**:

```ts
const parsed = invoiceIssued.parse(event); // Result
if (!parsed.ok) throw new NonRetryableJobError('bad event', { cause: parsed.error });

await inbox.once(transaction, { consumer: 'core.posting-engine', eventId: parsed.value.id }, () => post(parsed.value.payload));
```

`parse` checks the envelope, the topic, the version and the payload. Its errors say where the
problem is and never quote a value from the payload.

## Rules

- **Topics** are `producer.entity.event`: `sales.invoice.issued`. Only the producer emits its
  topics.
- **Money travels as `{ amount: "1500.50", currency: "AED" }`**, never as a number. Use
  `moneySchema`, `decimalSchema`, `uuidSchema` and `localDateSchema`.
- **Changing a payload** in a way old consumers cannot read means a new `version`, with both
  definitions kept while old events may still be in flight. A consumer that handles several
  versions puts them in a `createEventCatalog([...])` and calls `catalog.parse(event)`.
- The version rides in the `hk-event-version` header, which is how it fits the outbox's event
  shape without a column of its own.
- Event definitions for a product are added here, in the PR that builds the product.
