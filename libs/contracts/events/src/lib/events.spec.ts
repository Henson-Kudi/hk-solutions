import { Money } from '@hk/platform/universal';
import { z } from 'zod';
import {
  EVENT_VERSION_HEADER,
  createEventCatalog,
  decimalSchema,
  defineEvent,
  isTopic,
  localDateSchema,
  moneySchema,
  producerOf,
  uuidSchema,
  type WireEvent,
} from './events';

const EVENT_ID = '018f2c3a-7b1e-7000-8000-000000000001';
const INVOICE_ID = '018f2c3a-7b1e-7000-8000-000000000002';
const TENANT = '018f2c3a-7b1e-7000-8000-00000000000a';
const BUSINESS = '018f2c3a-7b1e-7000-8000-0000000000a1';

const invoiceIssued = defineEvent({
  topic: 'sales.invoice.issued',
  version: 1,
  schema: z.object({
    invoiceId: uuidSchema,
    issuedOn: localDateSchema,
    total: moneySchema,
    note: z.string().default(''),
  }),
});

const payload = {
  invoiceId: INVOICE_ID,
  issuedOn: '2026-11-27',
  total: { amount: '1500.50', currency: 'AED' },
};

/** What the outbox would deliver for a created event. */
const delivered = (
  created: { topic: string; payload: unknown; headers: Record<string, string> },
  overrides: Partial<WireEvent> = {},
): WireEvent => ({
  id: EVENT_ID,
  tenantId: TENANT,
  businessId: BUSINESS,
  occurredAt: '2026-11-27T10:00:00.000Z',
  ...created,
  ...overrides,
});

const errorOf = (result: { ok: boolean; error?: { code: string } }): string =>
  result.ok ? 'OK' : (result.error as { code: string }).code;

describe('topics', () => {
  it.each([
    'sales.invoice.issued',
    'core.journal.posted',
    'inventory.stock.consumed',
    'pos.cash_session.closed',
  ])('accepts %s', (topic) => {
    expect(isTopic(topic)).toBe(true);
  });

  it.each([
    'sales',
    'sales.issued',
    'Sales.invoice.issued',
    'sales..issued',
    'sales.invoice.issued.',
    'sales invoice issued',
    '',
    7,
  ])('rejects %p', (topic) => {
    expect(isTopic(topic)).toBe(false);
  });

  it('names the producer', () => {
    expect(producerOf('sales.invoice.issued')).toBe('sales');
    expect(producerOf('core.journal.posted')).toBe('core');
  });
});

describe('defineEvent', () => {
  it('refuses a malformed topic or version', () => {
    expect(() =>
      defineEvent({ topic: 'invoiceIssued', version: 1, schema: z.object({}) }),
    ).toThrow(/producer\.entity\.event/);
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        defineEvent({
          topic: 'sales.invoice.issued',
          version,
          schema: z.object({}),
        }),
      ).toThrow(/whole version number/);
    }
  });

  describe('create', () => {
    it('builds what the outbox takes, with the version in a header', () => {
      expect(invoiceIssued.create(payload)).toEqual({
        topic: 'sales.invoice.issued',
        payload: { ...payload, note: '' },
        headers: { [EVENT_VERSION_HEADER]: '1' },
      });
    });

    it("keeps the caller's headers, and its own version wins", () => {
      const created = invoiceIssued.create(payload, {
        traceparent: '00-abc-def-01',
        [EVENT_VERSION_HEADER]: '99',
      });
      expect(created.headers).toEqual({
        traceparent: '00-abc-def-01',
        [EVENT_VERSION_HEADER]: '1',
      });
    });

    it('accepts Money, which serialises to the wire shape', () => {
      const created = invoiceIssued.create({
        ...payload,
        total: Money.of('1500.50', 'AED').toJSON(),
      });
      expect(created.payload.total).toEqual({
        amount: '1500.5',
        currency: 'AED',
      });
    });

    it('throws rather than emit a payload its own definition rejects', () => {
      try {
        invoiceIssued.create({ ...payload, invoiceId: 'inv-1' });
        throw new Error('did not throw');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'EVENT_PAYLOAD_INVALID',
          kind: 'invariant',
          details: {
            topic: 'sales.invoice.issued',
            version: 1,
            issues: 1,
            firstPath: 'invoiceId',
          },
        });
      }
    });

    it('refuses a JS number as an amount', () => {
      expect(() =>
        invoiceIssued.create({
          ...payload,
          total: { amount: 1500.5 as unknown as string, currency: 'AED' },
        }),
      ).toThrow('The event payload does not match its definition.');
    });
  });

  describe('parse', () => {
    it('returns the typed envelope of a delivered event', () => {
      const result = invoiceIssued.parse(
        delivered(invoiceIssued.create(payload)),
      );
      expect(result).toEqual({
        ok: true,
        value: {
          id: EVENT_ID,
          topic: 'sales.invoice.issued',
          version: 1,
          occurredAt: '2026-11-27T10:00:00.000Z',
          tenantId: TENANT,
          businessId: BUSINESS,
          headers: { [EVENT_VERSION_HEADER]: '1' },
          payload: { ...payload, note: '' },
        },
      });
    });

    it('accepts an event with no tenant, as a system event has', () => {
      const result = invoiceIssued.parse(
        delivered(invoiceIssued.create(payload), {
          tenantId: null,
          businessId: null,
        }),
      );
      expect(result.ok).toBe(true);
    });

    it('rejects an event for another topic', () => {
      const other = defineEvent({
        topic: 'sales.invoice.voided',
        version: 1,
        schema: z.object({}),
      });
      expect(errorOf(invoiceIssued.parse(delivered(other.create({}))))).toBe(
        'EVENT_TOPIC_MISMATCH',
      );
    });

    it('rejects another version, and a missing version', () => {
      const created = invoiceIssued.create(payload);
      expect(
        errorOf(
          invoiceIssued.parse(
            delivered({ ...created, headers: { [EVENT_VERSION_HEADER]: '2' } }),
          ),
        ),
      ).toBe('EVENT_VERSION_UNSUPPORTED');
      expect(
        errorOf(invoiceIssued.parse(delivered({ ...created, headers: {} }))),
      ).toBe('EVENT_VERSION_UNSUPPORTED');
    });

    it('rejects a payload that does not match, without quoting it', () => {
      const result = invoiceIssued.parse(
        delivered({
          ...invoiceIssued.create(payload),
          payload: {
            ...payload,
            total: { amount: '12,50', currency: 'aed' },
            secret: 'do-not-quote',
          },
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'EVENT_PAYLOAD_INVALID',
          details: { topic: 'sales.invoice.issued', version: 1, issues: 2 },
        },
      });
      expect(JSON.stringify(result)).not.toContain('12,50');
      expect(JSON.stringify(result)).not.toContain('do-not-quote');
    });

    it.each([
      ['an id that is not a UUID', { id: 'evt-1' }],
      ['a tenant that is not a UUID', { tenantId: 'tenant-1' }],
      ['a time that is not an instant', { occurredAt: 'yesterday' }],
      ['a date without a time', { occurredAt: '2026-11-27' }],
      [
        'headers that are not strings',
        { headers: { a: 1 } as unknown as Record<string, string> },
      ],
      ['a malformed topic', { topic: 'invoice issued' }],
    ])('rejects an envelope with %s', (_label, overrides) => {
      expect(
        errorOf(
          invoiceIssued.parse(
            delivered(invoiceIssued.create(payload), overrides),
          ),
        ),
      ).toBe('EVENT_ENVELOPE_INVALID');
    });

    it('rejects something that is not an event at all', () => {
      expect(errorOf(invoiceIssued.parse(null as unknown as WireEvent))).toBe(
        'EVENT_ENVELOPE_INVALID',
      );
      expect(
        errorOf(invoiceIssued.parse('event' as unknown as WireEvent)),
      ).toBe('EVENT_ENVELOPE_INVALID');
    });
  });
});

describe('createEventCatalog', () => {
  const invoiceIssuedV2 = defineEvent({
    topic: 'sales.invoice.issued',
    version: 2,
    schema: z.object({ invoiceId: uuidSchema, totals: z.array(moneySchema) }),
  });
  const journalPosted = defineEvent({
    topic: 'core.journal.posted',
    version: 1,
    schema: z.object({ journalId: uuidSchema }),
  });
  const catalog = createEventCatalog([
    invoiceIssued,
    invoiceIssuedV2,
    journalPosted,
  ]);

  it('lists its topics once each, and finds a definition by topic and version', () => {
    expect(catalog.topics()).toEqual([
      'sales.invoice.issued',
      'core.journal.posted',
    ]);
    expect(catalog.get('sales.invoice.issued', 2)).toBe(invoiceIssuedV2);
    expect(catalog.get('sales.invoice.issued', 3)).toBeUndefined();
    expect(catalog.get('sales.invoice.voided', 1)).toBeUndefined();
  });

  it('parses each version of a topic with its own definition', () => {
    const v1 = catalog.parse(delivered(invoiceIssued.create(payload)));
    const v2 = catalog.parse(
      delivered(
        invoiceIssuedV2.create({
          invoiceId: INVOICE_ID,
          totals: [payload.total],
        }),
      ),
    );
    expect(v1).toMatchObject({ ok: true, value: { version: 1 } });
    expect(v2).toMatchObject({
      ok: true,
      value: { version: 2, payload: { totals: [payload.total] } },
    });
  });

  it('rejects an event it has no definition for', () => {
    const unknownVersion = delivered({
      ...invoiceIssued.create(payload),
      headers: { [EVENT_VERSION_HEADER]: '7' },
    });
    expect(catalog.parse(unknownVersion)).toMatchObject({
      ok: false,
      error: {
        code: 'EVENT_UNKNOWN',
        details: { topic: 'sales.invoice.issued', version: 7 },
      },
    });
    expect(
      errorOf(
        catalog.parse(
          delivered({ topic: 'crm.deal.won', payload: {}, headers: {} }),
        ),
      ),
    ).toBe('EVENT_UNKNOWN');
    expect(errorOf(catalog.parse(undefined as unknown as WireEvent))).toBe(
      'EVENT_UNKNOWN',
    );
  });

  it('refuses two definitions for the same topic and version', () => {
    expect(() => createEventCatalog([invoiceIssued, invoiceIssued])).toThrow(
      'Event sales.invoice.issued@1 is defined twice.',
    );
  });
});

describe('shared schemas', () => {
  it('uuidSchema accepts canonical UUIDs only', () => {
    expect(uuidSchema.safeParse(INVOICE_ID).success).toBe(true);
    expect(uuidSchema.safeParse(INVOICE_ID.toUpperCase()).success).toBe(false);
    expect(uuidSchema.safeParse('inv-1').success).toBe(false);
  });

  it('localDateSchema accepts real calendar dates only', () => {
    expect(localDateSchema.safeParse('2026-11-27').success).toBe(true);
    expect(localDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(localDateSchema.safeParse('27/11/2026').success).toBe(false);
  });

  it('decimalSchema and moneySchema accept strings, never numbers', () => {
    expect(decimalSchema.safeParse('1500.50').success).toBe(true);
    expect(decimalSchema.safeParse('-0.25').success).toBe(true);
    for (const bad of [1500.5, '1,500', '1e3', '', ' 5']) {
      expect(decimalSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      moneySchema.safeParse({ amount: '100', currency: 'XAF' }).success,
    ).toBe(true);
    expect(
      moneySchema.safeParse({ amount: 100, currency: 'XAF' }).success,
    ).toBe(false);
    expect(
      moneySchema.safeParse({ amount: '100', currency: 'xaf' }).success,
    ).toBe(false);
  });
});
