import {
  DomainError,
  err,
  isUuid,
  ok,
  type Result,
} from '@hk/platform/universal';
import { AUDIT_ERRORS, canonicalJson, type JsonObject } from './canonical';

/**
 * An audit event: who did what to which record, and when.
 *
 * Every create, update, delete, approval and login is recorded as one. Events
 * are never changed or removed; each carries the hash of the one before it,
 * so a change to any of them shows (see chain.ts).
 */

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'approve',
  'reject',
  'login',
  'login_failed',
  'logout',
  'export',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTOR_TYPES = ['user', 'service', 'system'] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Who acted. A user by id, a service by name, or the system itself. */
export interface AuditActor {
  readonly type: AuditActorType;
  /** The user's id, or the service's name. Null for the system. */
  readonly id: string | null;
}

/** The business whose audit trail an event belongs to. One chain per business. */
export interface AuditScope {
  readonly tenantId: string;
  readonly businessId: string;
}

/** What a caller supplies. The chain adds the rest. */
export interface NewAuditEvent {
  /** A UUID, made by the caller. */
  readonly id: string;
  /** When it happened, as an ISO 8601 instant in UTC: "2026-11-28T09:15:00.000Z". */
  readonly occurredAt: string;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  /** What kind of record: "sales.invoice", "core.user". */
  readonly entityType: string;
  /** Which record. Null when the event is not about one record, such as a failed login. */
  readonly entityId: string | null;
  /**
   * What changed, as plain data. NEVER put passwords, tokens, OTPs, ID numbers
   * or phone numbers here: an audit event cannot be edited or deleted later.
   * Decimals are strings.
   */
  readonly details: JsonObject;
  /** The request that caused it, for tracing. */
  readonly requestId: string | null;
}

/** A recorded event: a NewAuditEvent sealed into its business's chain. */
export interface AuditEvent extends NewAuditEvent, AuditScope {
  /** Position in the business's chain, starting at 1. */
  readonly sequence: number;
  /** The hash of the event before this one, or GENESIS_HASH for the first. */
  readonly previousHash: string;
  /** The hash of this event, which covers previousHash. */
  readonly hash: string;
}

const ENTITY_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_TEXT = 200;
/** Upper bound on the canonical text of the details, in characters. */
export const MAX_DETAILS_LENGTH = 16_000;

const isCanonicalInstant = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
};

const isShortText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= MAX_TEXT;

const includes = (list: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && list.includes(value);

/** Everything wrong with an event a caller wants recorded. Empty means it is valid. */
export const findAuditEventIssues = (event: NewAuditEvent): string[] => {
  const issues: string[] = [];
  if (!isUuid(event.id)) issues.push('id is not a UUID');
  if (!isCanonicalInstant(event.occurredAt)) {
    issues.push('occurredAt is not an ISO 8601 UTC instant');
  }
  if (!includes(AUDIT_ACTIONS, event.action)) {
    issues.push('action is not known');
  }
  if (!ENTITY_TYPE.test(String(event.entityType))) {
    issues.push('entityType is not of the form owner.entity');
  }
  if (event.entityId !== null && !isShortText(event.entityId)) {
    issues.push('entityId is empty or too long');
  }
  if (event.requestId !== null && !isShortText(event.requestId)) {
    issues.push('requestId is empty or too long');
  }
  const actor = event.actor;
  if (!actor || !includes(AUDIT_ACTOR_TYPES, actor.type)) {
    issues.push('actor type is not known');
  } else if (actor.type === 'system') {
    if (actor.id !== null) issues.push('the system actor has no id');
  } else if (!isShortText(actor.id)) {
    issues.push(`a ${actor.type} actor needs an id`);
  } else if (actor.type === 'user' && !isUuid(actor.id)) {
    issues.push('a user actor id is not a UUID');
  }
  return issues;
};

/**
 * Checks an event and its details. The details error is returned as it is,
 * because it says which rule the data broke.
 */
export const validateNewAuditEvent = (
  event: NewAuditEvent,
): Result<NewAuditEvent> => {
  const issues = findAuditEventIssues(event);
  if (issues.length > 0) {
    return err(
      new DomainError(
        AUDIT_ERRORS.EVENT_INVALID,
        `The audit event is not valid: ${issues.join('; ')}.`,
      ),
    );
  }
  if (
    typeof event.details !== 'object' ||
    event.details === null ||
    Array.isArray(event.details)
  ) {
    return err(
      new DomainError(
        AUDIT_ERRORS.DETAILS_INVALID,
        'Audit details must be an object.',
      ),
    );
  }
  let text: string;
  try {
    text = canonicalJson(event.details);
  } catch (error) {
    if (error instanceof DomainError) return err(error);
    throw error;
  }
  if (text.length > MAX_DETAILS_LENGTH) {
    return err(
      new DomainError(
        AUDIT_ERRORS.DETAILS_TOO_LARGE,
        'Audit details are too large. Record what changed, not whole documents.',
        { details: { length: text.length, limit: MAX_DETAILS_LENGTH } },
      ),
    );
  }
  return ok(event);
};
