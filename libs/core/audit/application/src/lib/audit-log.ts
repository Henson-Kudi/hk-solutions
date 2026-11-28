import {
  AUDIT_ERRORS,
  sealEvent,
  validateNewAuditEvent,
  verifyChain,
  type AuditAction,
  type AuditActor,
  type AuditEvent,
  type AuditScope,
  type ChainHead,
  type ChainVerification,
  type JsonObject,
  type Sha256,
} from '@hk/core/audit/domain';
import { DomainError, type Clock } from '@hk/platform/universal';
import type { AuditStore } from './ports';

/**
 * The audit log's use cases: record an event, read events, verify a chain.
 *
 * None of them runs offline. A device does not keep an audit chain: what it
 * does offline reaches the server as sync commands, and the server records
 * the audit events when it applies them.
 */
export const AUDIT_USE_CASES = {
  record: { name: 'core.audit.record', offline: false },
  list: { name: 'core.audit.list', offline: false },
  verify: { name: 'core.audit.verify', offline: false },
} as const;

/** What a caller says about something that happened. */
export interface RecordAuditInput {
  actor: AuditActor;
  action: AuditAction;
  /** "sales.invoice", "core.user". */
  entityType: string;
  entityId?: string | null;
  /**
   * What changed, as plain data. Never passwords, tokens, OTPs, ID numbers or
   * phone numbers: an audit event cannot be edited or deleted later.
   */
  details?: JsonObject;
  requestId?: string | null;
}

export interface VerifyAuditOptions {
  /** A head saved elsewhere. When given, the chain must end exactly there. */
  expectedHead?: ChainHead | null;
  /** How many events to read at a time. Defaults to 500. */
  pageSize?: number;
}

export interface ListAuditQuery {
  /** Return events after this sequence. 0 starts from the beginning. */
  afterSequence?: number;
  /** At most this many, 1 to 500. Defaults to 100. */
  limit?: number;
}

export interface AuditLogOptions {
  store: AuditStore;
  /** A real SHA-256 in production. */
  sha256: Sha256;
  clock: Clock;
  /** Makes event ids. A UUID v7 generator in production. */
  newId: () => string;
  /**
   * Applied to the details before they are recorded, to mask anything that
   * looks like a secret. Pass the platform redactor on the server. It is a
   * safety net, not a licence to pass secrets in.
   */
  redact?: (details: JsonObject) => JsonObject;
}

export interface AuditLog {
  /**
   * Records an event at the end of the business's chain and returns it.
   * Call it inside the transaction that makes the change, so the two are
   * saved or rolled back together.
   */
  record(scope: AuditScope, input: RecordAuditInput): Promise<AuditEvent>;
  list(scope: AuditScope, query?: ListAuditQuery): Promise<AuditEvent[]>;
  /** Checks the whole chain of the business, page by page. */
  verify(
    scope: AuditScope,
    options?: VerifyAuditOptions,
  ): Promise<ChainVerification>;
}

const DEFAULT_PAGE = 500;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const wholeNumber = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  what: string,
): number => {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) {
    throw new DomainError(
      AUDIT_ERRORS.EVENT_INVALID,
      `${what} must be a whole number from ${min} to ${max}.`,
    );
  }
  return chosen;
};

export const createAuditLog = (options: AuditLogOptions): AuditLog => {
  const { store, sha256, clock, newId } = options;

  const record = async (
    scope: AuditScope,
    input: RecordAuditInput,
  ): Promise<AuditEvent> => {
    const details = input.details ?? {};
    const checked = validateNewAuditEvent({
      id: newId(),
      occurredAt: clock.now().toISOString(),
      actor: input.actor,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      details: options.redact ? options.redact(details) : details,
      requestId: input.requestId ?? null,
    });
    if (!checked.ok) {
      throw checked.error;
    }
    return store.append(scope, (head) =>
      sealEvent(head, scope, checked.value, sha256),
    );
  };

  const list = (
    scope: AuditScope,
    query: ListAuditQuery = {},
  ): Promise<AuditEvent[]> =>
    store.read(scope, {
      afterSequence: wholeNumber(
        query.afterSequence,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        'afterSequence',
      ),
      limit: wholeNumber(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit'),
    });

  const verify = async (
    scope: AuditScope,
    verifyOptions: VerifyAuditOptions = {},
  ): Promise<ChainVerification> => {
    const pageSize = wholeNumber(
      verifyOptions.pageSize,
      DEFAULT_PAGE,
      1,
      5000,
      'pageSize',
    );
    let head: ChainHead | null = null;
    let checked = 0;
    for (;;) {
      const page = await store.read(scope, {
        afterSequence: head?.sequence ?? 0,
        limit: pageSize,
      });
      const result = verifyChain(scope, page, sha256, { after: head });
      if (!result.ok) {
        return { ...result, checked: checked + result.checked };
      }
      checked += result.checked;
      head = result.head;
      if (page.length < pageSize) break;
    }
    // The saved head is compared once, against where the whole chain ends.
    if (verifyOptions.expectedHead !== undefined) {
      const final = verifyChain(scope, [], sha256, {
        after: head,
        expectedHead: verifyOptions.expectedHead,
      });
      if (!final.ok) {
        return { ...final, checked };
      }
    }
    return { ok: true, checked, head };
  };

  return { record, list, verify };
};
