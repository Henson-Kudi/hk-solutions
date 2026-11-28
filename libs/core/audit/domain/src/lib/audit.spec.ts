import { isDomainError } from '@hk/platform/universal';
import {
  MAX_DETAILS_LENGTH,
  findAuditEventIssues,
  validateNewAuditEvent,
  type AuditEvent,
  type AuditScope,
  type NewAuditEvent,
} from './audit-event';
import { AUDIT_ERRORS, canonicalJson } from './canonical';
import {
  GENESIS_HASH,
  hashInput,
  hashOf,
  sealEvent,
  verifyChain,
  type ChainHead,
} from './chain';
import { insecureTestHash } from './test-hash';

const scope: AuditScope = {
  tenantId: '018f0000-0000-7000-8000-00000000000a',
  businessId: '018f0000-0000-7000-8000-00000000000b',
};
const otherScope: AuditScope = {
  tenantId: scope.tenantId,
  businessId: '018f0000-0000-7000-8000-00000000000c',
};
const userId = '018f0000-0000-7000-8000-0000000000aa';

const eventId = (n: number) =>
  `018f0000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const newEvent = (
  n: number,
  overrides: Partial<NewAuditEvent> = {},
): NewAuditEvent => ({
  id: eventId(n),
  occurredAt: `2026-11-28T09:${String(n % 60).padStart(2, '0')}:00.000Z`,
  actor: { type: 'user', id: userId },
  action: 'update',
  entityType: 'sales.invoice',
  entityId: `inv-${n}`,
  details: { field: 'status', from: 'draft', to: 'issued' },
  requestId: `req-${n}`,
  ...overrides,
});

/** A chain of `length` events for `scope`. */
const chainOf = (length: number, of: AuditScope = scope): AuditEvent[] => {
  const events: AuditEvent[] = [];
  let head: ChainHead | null = null;
  for (let n = 1; n <= length; n += 1) {
    const sealed = sealEvent(head, of, newEvent(n), insecureTestHash);
    events.push(sealed);
    head = { sequence: sealed.sequence, hash: sealed.hash };
  }
  return events;
};

const at = (events: AuditEvent[], index: number): AuditEvent => {
  const event = events[index];
  if (!event) throw new Error(`no event at ${index}`);
  return event;
};

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return isDomainError(error) ? error.code : String(error);
  }
  return undefined;
};

describe('canonical JSON', () => {
  it('writes the same text whatever order the keys were given in', () => {
    const first = canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } });
    const second = canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 });
    expect(first).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(second).toBe(first);
  });

  it('keeps the order of arrays, which is part of their meaning', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('writes null, booleans, whole numbers and strings', () => {
    expect(canonicalJson({ a: null, b: true, c: false, d: -7, e: '' })).toBe(
      '{"a":null,"b":true,"c":false,"d":-7,"e":""}',
    );
  });

  it('escapes strings the way JSON does', () => {
    expect(canonicalJson({ 'a"b': 'line\nbreak "quoted" é' })).toBe(
      '{"a\\"b":"line\\nbreak \\"quoted\\" é"}',
    );
  });

  it.each<[string, unknown]>([
    ['a fraction', { amount: 19.25 }],
    ['a number too large to be exact', { n: 2 ** 53 }],
    ['NaN', { n: Number.NaN }],
    ['infinity', { n: Number.POSITIVE_INFINITY }],
    ['undefined', { n: undefined }],
    ['a function', { n: () => 1 }],
    ['a Date', { at: new Date(0) }],
    ['a Map', { m: new Map() }],
    ['a class instance', { m: new (class Thing {})() }],
    ['a bigint', { n: BigInt(10) }],
    ['a symbol', { n: Symbol('x') }],
  ])('refuses %s', (_name, value) => {
    expect(codeOf(() => canonicalJson(value))).toBe(
      AUDIT_ERRORS.DETAILS_INVALID,
    );
  });

  it('refuses data nested too deeply', () => {
    let value: unknown = 'leaf';
    for (let level = 0; level < 10; level += 1) value = { next: value };
    expect(codeOf(() => canonicalJson(value))).toBe(
      AUDIT_ERRORS.DETAILS_TOO_LARGE,
    );
  });

  it('accepts an object with no prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['a'] = 1;
    expect(canonicalJson(bare)).toBe('{"a":1}');
  });
});

describe('audit event validation', () => {
  it('accepts a well-formed event', () => {
    expect(findAuditEventIssues(newEvent(1))).toEqual([]);
    expect(validateNewAuditEvent(newEvent(1)).ok).toBe(true);
  });

  it('accepts a service and a system actor, and an event about no record', () => {
    expect(
      findAuditEventIssues(
        newEvent(1, { actor: { type: 'service', id: 'sales' } }),
      ),
    ).toEqual([]);
    expect(
      findAuditEventIssues(
        newEvent(1, { actor: { type: 'system', id: null } }),
      ),
    ).toEqual([]);
    expect(
      findAuditEventIssues(
        newEvent(1, {
          action: 'login_failed',
          entityId: null,
          requestId: null,
        }),
      ),
    ).toEqual([]);
  });

  it.each<[string, Partial<NewAuditEvent>, string]>([
    ['an id that is not a UUID', { id: 'abc' }, 'id is not a UUID'],
    [
      'a date without a time',
      { occurredAt: '2026-11-28' },
      'occurredAt is not an ISO 8601 UTC instant',
    ],
    [
      'a time with an offset',
      { occurredAt: '2026-11-28T10:15:00.000+01:00' },
      'occurredAt is not an ISO 8601 UTC instant',
    ],
    [
      'a time without milliseconds',
      { occurredAt: '2026-11-28T09:15:00Z' },
      'occurredAt is not an ISO 8601 UTC instant',
    ],
    [
      'an unknown action',
      { action: 'tweak' as NewAuditEvent['action'] },
      'action is not known',
    ],
    [
      'an entity type with no owner',
      { entityType: 'invoice' },
      'entityType is not of the form owner.entity',
    ],
    [
      'an entity type in capitals',
      { entityType: 'Sales.Invoice' },
      'entityType is not of the form owner.entity',
    ],
    ['an empty entity id', { entityId: ' ' }, 'entityId is empty or too long'],
    [
      'an entity id that is too long',
      { entityId: 'x'.repeat(201) },
      'entityId is empty or too long',
    ],
    [
      'an unknown actor type',
      { actor: { type: 'robot' as 'user', id: 'r2' } },
      'actor type is not known',
    ],
    [
      'a user actor without an id',
      { actor: { type: 'user', id: null } },
      'a user actor needs an id',
    ],
    [
      'a user actor whose id is not a UUID',
      { actor: { type: 'user', id: 'henson' } },
      'a user actor id is not a UUID',
    ],
    [
      'a system actor with an id',
      { actor: { type: 'system', id: 'cron' } },
      'the system actor has no id',
    ],
  ])('reports %s', (_name, overrides, expected) => {
    expect(findAuditEventIssues(newEvent(1, overrides))).toContain(expected);
    const result = validateNewAuditEvent(newEvent(1, overrides));
    expect(!result.ok && result.error.code).toBe(AUDIT_ERRORS.EVENT_INVALID);
  });

  it('refuses details that are not plain data', () => {
    const result = validateNewAuditEvent(
      newEvent(1, { details: { amount: 19.25 } }),
    );
    expect(!result.ok && result.error.code).toBe(AUDIT_ERRORS.DETAILS_INVALID);
  });

  it('refuses details that are not an object', () => {
    const result = validateNewAuditEvent(
      newEvent(1, { details: ['a'] as unknown as NewAuditEvent['details'] }),
    );
    expect(!result.ok && result.error.code).toBe(AUDIT_ERRORS.DETAILS_INVALID);
  });

  it('refuses details that are too large, without echoing them', () => {
    const secret = 'S'.repeat(MAX_DETAILS_LENGTH);
    const result = validateNewAuditEvent(
      newEvent(1, { details: { blob: secret } }),
    );
    expect(!result.ok && result.error.code).toBe(
      AUDIT_ERRORS.DETAILS_TOO_LARGE,
    );
    expect(!result.ok && JSON.stringify(result.error.toJSON())).not.toContain(
      'SSSS',
    );
  });
});

describe('sealing an event into a chain', () => {
  it('starts a chain at sequence 1, linked to the genesis hash', () => {
    const first = sealEvent(null, scope, newEvent(1), insecureTestHash);
    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(first.previousHash).toMatch(/^0{64}$/);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tenantId).toBe(scope.tenantId);
    expect(first.businessId).toBe(scope.businessId);
  });

  it('links each event to the one before it', () => {
    const [first, second, third] = chainOf(3);
    expect(second?.sequence).toBe(2);
    expect(second?.previousHash).toBe(first?.hash);
    expect(third?.sequence).toBe(3);
    expect(third?.previousHash).toBe(second?.hash);
  });

  it('hashes the content together with the previous hash', () => {
    const event = at(chainOf(2), 1);
    expect(event.hash).toBe(insecureTestHash(hashInput(event)));
    expect(hashInput(event)).toContain(event.previousHash);
    expect(hashOf(event, insecureTestHash)).toBe(event.hash);
  });

  it('gives the same hash whatever order the details were written in', () => {
    const one = sealEvent(
      null,
      scope,
      newEvent(1, { details: { a: 1, b: { x: 1, y: 2 } } }),
      insecureTestHash,
    );
    const two = sealEvent(
      null,
      scope,
      newEvent(1, { details: { b: { y: 2, x: 1 }, a: 1 } }),
      insecureTestHash,
    );
    expect(two.hash).toBe(one.hash);
  });

  it.each<[string, Partial<NewAuditEvent>]>([
    ['the id', { id: eventId(999) }],
    ['the time', { occurredAt: '2026-11-28T09:01:00.001Z' }],
    ['the actor', { actor: { type: 'service', id: 'sales' } }],
    ['the action', { action: 'delete' }],
    ['the entity type', { entityType: 'sales.quote' }],
    ['the entity id', { entityId: 'inv-2' }],
    [
      'the details',
      { details: { field: 'status', from: 'draft', to: 'void' } },
    ],
    ['the request id', { requestId: 'req-x' }],
  ])('gives a different hash when %s differs', (_name, overrides) => {
    const base = sealEvent(null, scope, newEvent(1), insecureTestHash);
    const changed = sealEvent(
      null,
      scope,
      newEvent(1, overrides),
      insecureTestHash,
    );
    expect(changed.hash).not.toBe(base.hash);
  });

  it('gives a different hash in another business, at another position, or after another event', () => {
    const base = sealEvent(null, scope, newEvent(1), insecureTestHash);
    expect(
      sealEvent(null, otherScope, newEvent(1), insecureTestHash).hash,
    ).not.toBe(base.hash);
    expect(
      sealEvent(
        { sequence: 5, hash: GENESIS_HASH },
        scope,
        newEvent(1),
        insecureTestHash,
      ).hash,
    ).not.toBe(base.hash);
    expect(
      sealEvent(
        { sequence: 0, hash: 'f'.repeat(64) },
        scope,
        newEvent(1),
        insecureTestHash,
      ).hash,
    ).not.toBe(base.hash);
  });

  it('copies the actor, so a later change to the input cannot alter the event', () => {
    const actor = { type: 'user' as const, id: userId };
    const sealed = sealEvent(
      null,
      scope,
      newEvent(1, { actor }),
      insecureTestHash,
    );
    actor.id = '018f0000-0000-7000-8000-0000000000bb';
    expect(sealed.actor.id).toBe(userId);
  });
});

describe('verifying a chain', () => {
  it('accepts an empty chain', () => {
    expect(verifyChain(scope, [], insecureTestHash)).toEqual({
      ok: true,
      checked: 0,
      head: null,
    });
  });

  it('accepts an intact chain and reports its head', () => {
    const events = chainOf(25);
    const last = at(events, 24);
    expect(verifyChain(scope, events, insecureTestHash)).toEqual({
      ok: true,
      checked: 25,
      head: { sequence: 25, hash: last.hash },
    });
  });

  it('catches an edited event at that event', () => {
    const events = chainOf(10);
    events[4] = { ...at(events, 4), details: { field: 'total', to: '0' } };
    expect(verifyChain(scope, events, insecureTestHash)).toEqual({
      ok: false,
      reason: 'hash',
      brokenAt: 5,
      checked: 4,
    });
  });

  it.each<[string, (event: AuditEvent) => AuditEvent]>([
    ['the actor', (e) => ({ ...e, actor: { type: 'system', id: null } })],
    ['the action', (e) => ({ ...e, action: 'delete' })],
    ['the time', (e) => ({ ...e, occurredAt: '2020-01-01T00:00:00.000Z' })],
    ['the entity id', (e) => ({ ...e, entityId: 'inv-999' })],
    ['the entity type', (e) => ({ ...e, entityType: 'sales.quote' })],
    ['the request id', (e) => ({ ...e, requestId: null })],
    ['the event id', (e) => ({ ...e, id: eventId(4242) })],
    ['the hash itself', (e) => ({ ...e, hash: 'a'.repeat(64) })],
  ])('catches a change to %s', (_name, change) => {
    const events = chainOf(6);
    events[2] = change(at(events, 2));
    const result = verifyChain(scope, events, insecureTestHash);
    expect(result).toMatchObject({ ok: false, reason: 'hash', brokenAt: 3 });
  });

  it('catches an edit hidden by recomputing that event’s hash, at the next event', () => {
    const events = chainOf(10);
    const edited = { ...at(events, 4), details: { field: 'total', to: '0' } };
    events[4] = { ...edited, hash: hashOf(edited, insecureTestHash) };
    expect(verifyChain(scope, events, insecureTestHash)).toEqual({
      ok: false,
      reason: 'previous_hash',
      brokenAt: 6,
      checked: 5,
    });
  });

  it('catches a removed event', () => {
    const events = chainOf(10);
    events.splice(3, 1);
    expect(verifyChain(scope, events, insecureTestHash)).toEqual({
      ok: false,
      reason: 'sequence',
      brokenAt: 5,
      checked: 3,
    });
  });

  it('catches a removed event hidden by renumbering the rest', () => {
    const events = chainOf(6);
    events.splice(2, 1);
    const renumbered = events.map((event, index) => ({
      ...event,
      sequence: index + 1,
    }));
    const result = verifyChain(scope, renumbered, insecureTestHash);
    expect(result).toMatchObject({ ok: false, brokenAt: 3 });
    expect(['previous_hash', 'hash']).toContain(
      !result.ok ? result.reason : '',
    );
  });

  it('catches a removed first event', () => {
    const events = chainOf(5).slice(1);
    expect(verifyChain(scope, events, insecureTestHash)).toMatchObject({
      ok: false,
      reason: 'sequence',
      brokenAt: 2,
      checked: 0,
    });
  });

  it('catches an inserted event', () => {
    const events = chainOf(5);
    const forged = sealEvent(
      { sequence: 2, hash: at(events, 1).hash },
      scope,
      newEvent(77),
      insecureTestHash,
    );
    events.splice(2, 0, forged);
    // The forged event fits after event 2, but the real event 3 no longer follows.
    expect(verifyChain(scope, events, insecureTestHash)).toMatchObject({
      ok: false,
      reason: 'sequence',
      brokenAt: 3,
      checked: 3,
    });
  });

  it('catches two events swapped', () => {
    const events = chainOf(5);
    const second = at(events, 1);
    events[1] = at(events, 2);
    events[2] = second;
    expect(verifyChain(scope, events, insecureTestHash)).toMatchObject({
      ok: false,
      reason: 'sequence',
      brokenAt: 3,
      checked: 1,
    });
  });

  it('catches an event repeated', () => {
    const events = chainOf(4);
    events.splice(2, 0, at(events, 1));
    expect(verifyChain(scope, events, insecureTestHash)).toMatchObject({
      ok: false,
      reason: 'sequence',
      brokenAt: 2,
    });
  });

  it('catches an event from another business', () => {
    const events = chainOf(4);
    events[2] = at(chainOf(4, otherScope), 2);
    expect(verifyChain(scope, events, insecureTestHash)).toMatchObject({
      ok: false,
      reason: 'scope',
      brokenAt: 3,
      checked: 2,
    });
  });

  it('refuses a whole chain presented under another business', () => {
    expect(verifyChain(otherScope, chainOf(3), insecureTestHash)).toMatchObject(
      { ok: false, reason: 'scope', brokenAt: 1, checked: 0 },
    );
  });

  it('treats details that are no longer plain data as a changed event', () => {
    const events = chainOf(3);
    events[1] = {
      ...at(events, 1),
      details: { amount: 0.5 } as unknown as AuditEvent['details'],
    };
    expect(verifyChain(scope, events, insecureTestHash)).toMatchObject({
      ok: false,
      reason: 'hash',
      brokenAt: 2,
    });
  });

  describe('against a saved head', () => {
    it('accepts a chain that ends at the saved head', () => {
      const events = chainOf(8);
      const head = { sequence: 8, hash: at(events, 7).hash };
      expect(
        verifyChain(scope, events, insecureTestHash, { expectedHead: head }).ok,
      ).toBe(true);
    });

    it('catches events cut off the end, which nothing else can', () => {
      const events = chainOf(8);
      const head = { sequence: 8, hash: at(events, 7).hash };
      const truncated = events.slice(0, 6);
      // Without the saved head the shorter chain looks intact.
      expect(verifyChain(scope, truncated, insecureTestHash).ok).toBe(true);
      expect(
        verifyChain(scope, truncated, insecureTestHash, { expectedHead: head }),
      ).toEqual({ ok: false, reason: 'head', brokenAt: 8, checked: 6 });
    });

    it('catches a chain rewritten from some point on', () => {
      const events = chainOf(6);
      const head = { sequence: 6, hash: at(events, 5).hash };
      // Rebuild events 4 to 6 with different content and valid links.
      const rewritten = events.slice(0, 3);
      let link: ChainHead = { sequence: 3, hash: at(events, 2).hash };
      for (let n = 4; n <= 6; n += 1) {
        const sealed = sealEvent(
          link,
          scope,
          newEvent(n, { details: { rewritten: true } }),
          insecureTestHash,
        );
        rewritten.push(sealed);
        link = { sequence: sealed.sequence, hash: sealed.hash };
      }
      expect(verifyChain(scope, rewritten, insecureTestHash).ok).toBe(true);
      expect(
        verifyChain(scope, rewritten, insecureTestHash, { expectedHead: head }),
      ).toMatchObject({ ok: false, reason: 'head', brokenAt: 6 });
    });

    it('catches a chain emptied altogether', () => {
      expect(
        verifyChain(scope, [], insecureTestHash, {
          expectedHead: { sequence: 3, hash: 'a'.repeat(64) },
        }),
      ).toMatchObject({ ok: false, reason: 'head', brokenAt: 3, checked: 0 });
    });

    it('accepts an empty chain when no head was ever saved', () => {
      expect(
        verifyChain(scope, [], insecureTestHash, { expectedHead: null }).ok,
      ).toBe(true);
    });
  });

  describe('in pages', () => {
    it('gives the same answer as checking the whole chain at once', () => {
      const events = chainOf(23);
      let head: ChainHead | null = null;
      let checked = 0;
      for (let start = 0; start < events.length; start += 5) {
        const page = events.slice(start, start + 5);
        const result = verifyChain(scope, page, insecureTestHash, {
          after: head,
        });
        if (!result.ok) throw new Error('a page failed');
        head = result.head;
        checked += result.checked;
      }
      expect(checked).toBe(23);
      expect(head).toEqual({ sequence: 23, hash: at(events, 22).hash });
    });

    it('catches a break that falls on a page boundary', () => {
      const events = chainOf(10);
      const first = verifyChain(scope, events.slice(0, 5), insecureTestHash);
      if (!first.ok) throw new Error('the first page failed');
      // Event 6 is missing: the second page starts at 7.
      expect(
        verifyChain(scope, events.slice(6), insecureTestHash, {
          after: first.head,
        }),
      ).toMatchObject({ ok: false, reason: 'sequence', brokenAt: 7 });
    });
  });
});

describe('the test hash', () => {
  it('is deterministic and 64 hex characters', () => {
    expect(insecureTestHash('abc')).toBe(insecureTestHash('abc'));
    expect(insecureTestHash('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(insecureTestHash('')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when one character changes', () => {
    expect(insecureTestHash('abc')).not.toBe(insecureTestHash('abd'));
    expect(insecureTestHash('abc')).not.toBe(insecureTestHash('abc '));
  });
});
