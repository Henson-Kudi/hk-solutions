import {
  DomainError,
  err,
  isUuid,
  ok,
  parseLocalDate,
  type Result,
} from '@hk/platform/universal';
import { z } from 'zod';

/**
 * Events: what one service tells the others.
 *
 * An event is defined once, here in contracts, with its topic, a version and
 * a Zod schema for its payload. The producer builds events through the
 * definition and the consumer parses them through the same definition, so
 * both sides agree on the shape and neither trusts the other's JSON.
 *
 *   export const invoiceIssued = defineEvent({
 *     topic: 'sales.invoice.issued',
 *     version: 1,
 *     schema: z.object({ invoiceId: uuidSchema, total: moneySchema }),
 *   });
 *
 *   // producer, inside its transaction
 *   await outbox.append(transaction, invoiceIssued.create({ invoiceId, total }));
 *
 *   // consumer
 *   const parsed = invoiceIssued.parse(event);
 */

/** The header that carries an event's schema version across the queue. */
export const EVENT_VERSION_HEADER = 'hk-event-version';

const TOPIC = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

/** True for a topic of the form producer.entity.event, such as "sales.invoice.issued". */
export const isTopic = (value: unknown): value is string =>
  typeof value === 'string' && TOPIC.test(value);

/** The service that owns a topic: its first segment. */
export const producerOf = (topic: string): string =>
  topic.slice(0, topic.indexOf('.'));

/**
 * An event as it travels: the shape the outbox stores and the queue
 * delivers (OutboxEvent in @hk/platform/outbox has exactly these fields).
 */
export interface WireEvent {
  id: string;
  topic: string;
  payload: unknown;
  tenantId: string | null;
  businessId: string | null;
  headers: Record<string, string>;
  occurredAt: string;
}

/** An event after it was checked against its definition. */
export interface EventEnvelope<Payload> {
  /** Unique per event. Consumers deduplicate on it with the inbox. */
  id: string;
  topic: string;
  version: number;
  /** ISO 8601 instant. */
  occurredAt: string;
  tenantId: string | null;
  businessId: string | null;
  headers: Record<string, string>;
  payload: Payload;
}

/** What the producer hands to the outbox. */
export interface NewEvent<Payload> {
  topic: string;
  payload: Payload;
  headers: Record<string, string>;
}

export interface EventDefinition<Schema extends z.ZodType> {
  readonly topic: string;
  readonly version: number;
  readonly schema: Schema;
  /**
   * Builds the event for the outbox. Throws EVENT_PAYLOAD_INVALID if the
   * payload does not match the schema: a producer never emits an event its
   * own definition rejects.
   */
  create(
    payload: z.input<Schema>,
    headers?: Record<string, string>,
  ): NewEvent<z.output<Schema>>;
  /** Checks a delivered event: topic, version and payload. */
  parse(event: WireEvent): Result<EventEnvelope<z.output<Schema>>>;
}

const invalid = (code: string, message: string, details = {}): DomainError =>
  new DomainError(code, message, { details });

/** Where the payload is wrong, without quoting any value from it. */
const describeIssues = (
  error: z.ZodError,
): { issues: number; firstPath: string } => ({
  issues: error.issues.length,
  firstPath: error.issues[0]?.path.map(String).join('.') ?? '',
});

const envelopeSchema = z.object({
  id: z.string().refine(isUuid),
  topic: z.string().refine(isTopic),
  payload: z.unknown(),
  tenantId: z.string().refine(isUuid).nullable(),
  businessId: z.string().refine(isUuid).nullable(),
  headers: z.record(z.string(), z.string()),
  occurredAt: z
    .string()
    .refine(
      (value) =>
        /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)),
    ),
});

export const defineEvent = <Schema extends z.ZodType>(definition: {
  topic: string;
  version: number;
  schema: Schema;
}): EventDefinition<Schema> => {
  const { topic, version, schema } = definition;
  if (!isTopic(topic)) {
    throw new Error(
      `Event topic "${topic}" is not of the form producer.entity.event.`,
    );
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Event "${topic}" needs a whole version number from 1.`);
  }

  return {
    topic,
    version,
    schema,
    create: (payload, headers = {}) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new DomainError(
          'EVENT_PAYLOAD_INVALID',
          'The event payload does not match its definition.',
          {
            kind: 'invariant',
            details: { topic, version, ...describeIssues(parsed.error) },
          },
        );
      }
      return {
        topic,
        payload: parsed.data,
        headers: { ...headers, [EVENT_VERSION_HEADER]: String(version) },
      };
    },
    parse: (event) => {
      const envelope = envelopeSchema.safeParse(event);
      if (!envelope.success) {
        return err(
          invalid('EVENT_ENVELOPE_INVALID', 'The event is malformed.', {
            ...describeIssues(envelope.error),
          }),
        );
      }
      if (envelope.data.topic !== topic) {
        return err(
          invalid('EVENT_TOPIC_MISMATCH', 'The event is for another topic.', {
            expected: topic,
            received: envelope.data.topic,
          }),
        );
      }
      const received = envelope.data.headers[EVENT_VERSION_HEADER];
      if (received !== String(version)) {
        return err(
          invalid(
            'EVENT_VERSION_UNSUPPORTED',
            'The event has a version this definition does not handle.',
            { topic, expected: version, received: received ?? null },
          ),
        );
      }
      const payload = schema.safeParse(envelope.data.payload);
      if (!payload.success) {
        return err(
          invalid(
            'EVENT_PAYLOAD_INVALID',
            'The event payload does not match its definition.',
            { topic, version, ...describeIssues(payload.error) },
          ),
        );
      }
      return ok({
        id: envelope.data.id,
        topic,
        version,
        occurredAt: envelope.data.occurredAt,
        tenantId: envelope.data.tenantId,
        businessId: envelope.data.businessId,
        headers: envelope.data.headers,
        payload: payload.data,
      });
    },
  };
};

export interface EventCatalog {
  /** Every topic in the catalog. */
  topics(): string[];
  /** The definition for a topic and version, if there is one. */
  get(topic: string, version: number): EventDefinition<z.ZodType> | undefined;
  /**
   * Parses any delivered event with the definition that matches its topic
   * and version. A consumer that handles several versions of a topic lists
   * them all in its catalog.
   */
  parse(event: WireEvent): Result<EventEnvelope<unknown>>;
}

/** Groups definitions. Throws if two of them share a topic and version. */
export const createEventCatalog = (
  definitions: readonly EventDefinition<z.ZodType>[],
): EventCatalog => {
  const byKey = new Map<string, EventDefinition<z.ZodType>>();
  for (const definition of definitions) {
    const key = `${definition.topic}@${definition.version}`;
    if (byKey.has(key)) {
      throw new Error(`Event ${key} is defined twice.`);
    }
    byKey.set(key, definition);
  }
  return {
    topics: () => [
      ...new Set(definitions.map((definition) => definition.topic)),
    ],
    get: (topic, version) => byKey.get(`${topic}@${version}`),
    parse: (event) => {
      const version = Number(event?.headers?.[EVENT_VERSION_HEADER]);
      const definition = byKey.get(`${event?.topic}@${version}`);
      if (!definition) {
        return err(
          invalid(
            'EVENT_UNKNOWN',
            'No definition for this event topic and version.',
            {
              topic: typeof event?.topic === 'string' ? event.topic : null,
              version: Number.isInteger(version) ? version : null,
            },
          ),
        );
      }
      return definition.parse(event);
    },
  };
};

/** A UUID in canonical lower-case form. */
export const uuidSchema = z.string().refine(isUuid, 'must be a UUID');

/** A calendar date, YYYY-MM-DD. */
export const localDateSchema = z
  .string()
  .refine((value) => parseLocalDate(value).ok, 'must be a date, YYYY-MM-DD');

/** A plain decimal string such as "1500.50". Never a number. */
export const decimalSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

/** Money as it travels: a decimal string and an ISO 4217 code. */
export const moneySchema = z.object({
  amount: decimalSchema,
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code'),
});
