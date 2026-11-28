import type { AuditEvent, AuditScope, NewAuditEvent } from './audit-event';
import { canonicalJson } from './canonical';

/**
 * The hash chain.
 *
 * Each event's hash is taken over its own content AND the hash of the event
 * before it. So:
 *
 *   - change an event, and its hash no longer matches its content;
 *   - recompute that hash to hide the change, and the next event's
 *     "previous hash" no longer matches, and so on to the end of the chain;
 *   - remove or insert an event, and the sequence or the links break.
 *
 * To hide an edit, every later event would have to be rewritten. Comparing
 * the last hash with a copy kept elsewhere (the "head") catches even that,
 * and is the only way to notice events cut off the end.
 *
 * The hash function is passed in. This code runs on servers, in browsers and
 * on phones, and each has its own SHA-256.
 */

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lower-case hex characters. */
export type Sha256 = (text: string) => string;

/** The "previous hash" of the first event in a chain. */
export const GENESIS_HASH = '0'.repeat(64);

/** Bumped if the hashed content ever changes shape, so old events stay verifiable. */
export const CHAIN_VERSION = 1;

/** The end of a chain: the last event's position and hash. */
export interface ChainHead {
  readonly sequence: number;
  readonly hash: string;
}

type Unhashed = Omit<AuditEvent, 'hash'>;

/** The exact text an event's hash is taken over. */
export const hashInput = (event: Unhashed): string =>
  canonicalJson({
    v: CHAIN_VERSION,
    tenantId: event.tenantId,
    businessId: event.businessId,
    sequence: event.sequence,
    previousHash: event.previousHash,
    id: event.id,
    occurredAt: event.occurredAt,
    actor: { type: event.actor.type, id: event.actor.id },
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    details: event.details,
    requestId: event.requestId,
  });

export const hashOf = (event: Unhashed, sha256: Sha256): string =>
  sha256(hashInput(event));

/**
 * Adds an event to the end of a chain: gives it the next sequence, links it
 * to the head, and hashes it. Pass null as the head for a business's first
 * event.
 */
export const sealEvent = (
  head: ChainHead | null,
  scope: AuditScope,
  event: NewAuditEvent,
  sha256: Sha256,
): AuditEvent => {
  const unhashed: Unhashed = {
    tenantId: scope.tenantId,
    businessId: scope.businessId,
    sequence: head ? head.sequence + 1 : 1,
    previousHash: head ? head.hash : GENESIS_HASH,
    id: event.id,
    occurredAt: event.occurredAt,
    actor: { type: event.actor.type, id: event.actor.id },
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    details: event.details,
    requestId: event.requestId,
  };
  return { ...unhashed, hash: hashOf(unhashed, sha256) };
};

export type ChainBreak =
  /** An event belongs to another business. */
  | 'scope'
  /** The sequence skips, repeats or goes backwards: an event was removed, added or moved. */
  | 'sequence'
  /** An event does not point at the hash of the one before it. */
  | 'previous_hash'
  /** An event's content does not match its hash: it was changed. */
  | 'hash'
  /** The chain is intact but does not end where the saved head says it should. */
  | 'head';

export type ChainVerification =
  | {
      readonly ok: true;
      /** How many events were checked. */
      readonly checked: number;
      /** Where the checked events end, or null when there were none. */
      readonly head: ChainHead | null;
    }
  | {
      readonly ok: false;
      readonly reason: ChainBreak;
      /** The sequence of the first event that fails, or of the head for 'head'. */
      readonly brokenAt: number;
      /** How many events were found intact before the break. */
      readonly checked: number;
    };

export interface VerifyOptions {
  /**
   * Where the events start. Leave it out to check from the first event.
   * Pass the head of the previous page to check a long chain in pages.
   */
  readonly after?: ChainHead | null;
  /**
   * A head saved elsewhere. When given, the chain must end exactly there,
   * which is how events cut off the end are noticed.
   */
  readonly expectedHead?: ChainHead | null;
}

/**
 * Checks events, in order, against the chain rules. It stops at the first
 * break and says where and why.
 */
export const verifyChain = (
  scope: AuditScope,
  events: readonly AuditEvent[],
  sha256: Sha256,
  options: VerifyOptions = {},
): ChainVerification => {
  let head: ChainHead | null = options.after ?? null;
  let checked = 0;

  for (const event of events) {
    const fail = (reason: ChainBreak): ChainVerification => ({
      ok: false,
      reason,
      brokenAt: event.sequence,
      checked,
    });
    if (
      event.tenantId !== scope.tenantId ||
      event.businessId !== scope.businessId
    ) {
      return fail('scope');
    }
    if (event.sequence !== (head ? head.sequence + 1 : 1)) {
      return fail('sequence');
    }
    if (event.previousHash !== (head ? head.hash : GENESIS_HASH)) {
      return fail('previous_hash');
    }
    let expected: string;
    try {
      expected = hashOf(event, sha256);
    } catch {
      // Content that has no canonical form was not written by this code.
      return fail('hash');
    }
    if (event.hash !== expected) {
      return fail('hash');
    }
    head = { sequence: event.sequence, hash: event.hash };
    checked += 1;
  }

  const expectedHead = options.expectedHead;
  if (expectedHead !== undefined) {
    const same =
      expectedHead === null
        ? head === null
        : head !== null &&
          head.sequence === expectedHead.sequence &&
          head.hash === expectedHead.hash;
    if (!same) {
      return {
        ok: false,
        reason: 'head',
        brokenAt: expectedHead?.sequence ?? 0,
        checked,
      };
    }
  }
  return { ok: true, checked, head };
};
