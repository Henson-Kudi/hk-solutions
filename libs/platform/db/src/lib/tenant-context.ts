import { AsyncLocalStorage } from 'node:async_hooks';
import { DomainError, isUuid } from '@hk/platform/universal';

/**
 * Whose data the current piece of work may touch.
 *
 * It is set once at the edge of a unit of work: from the verified user token
 * on a request, and from the envelope on an event, a job or a sync command.
 * Everything below reads it from here, so a handler cannot forget to pass it
 * and cannot pass the wrong one.
 */
export interface TenantContext {
  /** The subscribing account. */
  readonly tenantId: string;
  /** The legal entity whose books are being read or written. */
  readonly businessId: string;
  /** The branch the work is done at, when there is one. */
  readonly branchId?: string;
  /** The user on whose behalf this runs. Absent for system work such as a scheduled job. */
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

const invalid = (field: string): DomainError =>
  new DomainError(
    'TENANT_CONTEXT_INVALID',
    'Tenant context ids must be UUIDs in canonical lower-case form.',
    { kind: 'invariant', details: { field } },
  );

const validated = (context: TenantContext): TenantContext => {
  if (!isUuid(context.tenantId)) throw invalid('tenantId');
  if (!isUuid(context.businessId)) throw invalid('businessId');
  if (context.branchId !== undefined && !isUuid(context.branchId)) {
    throw invalid('branchId');
  }
  if (context.userId !== undefined && !isUuid(context.userId)) {
    throw invalid('userId');
  }
  return Object.freeze({ ...context });
};

/**
 * Runs `action` on behalf of one business.
 *
 * A context cannot be replaced from inside: starting a second one for a
 * different tenant or business throws. Work for another business starts from
 * the edge again (a new request, a new job). That makes "which business is
 * this code running for?" answerable by looking at one place.
 *
 * Re-entering with the same tenant and business is allowed, and may refine
 * the branch or user.
 */
export const runWithTenantContext = <T>(
  context: TenantContext,
  action: () => T,
): T => {
  const next = validated(context);
  const current = storage.getStore();
  if (
    current &&
    (current.tenantId !== next.tenantId ||
      current.businessId !== next.businessId)
  ) {
    throw new DomainError(
      'TENANT_CONTEXT_SWITCH',
      'A tenant context is already active for another business.',
      { kind: 'invariant' },
    );
  }
  return storage.run(next, action);
};

/** The active context, or undefined when there is none. */
export const getTenantContext = (): TenantContext | undefined =>
  storage.getStore();

/** The active context. Throws when there is none: data access without a tenant is a bug. */
export const requireTenantContext = (): TenantContext => {
  const context = storage.getStore();
  if (!context) {
    throw new DomainError(
      'TENANT_CONTEXT_MISSING',
      'This code needs a tenant context and none is active.',
      { kind: 'invariant' },
    );
  }
  return context;
};
