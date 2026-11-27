/**
 * Who is making a request, as proven by a verified internal token.
 *
 * user     A person, acting in one business. The gateway checked their session,
 *          their membership of the business and the business's entitlements,
 *          then minted the token.
 * service  Another service calling on its own behalf.
 */
export type Principal = UserPrincipal | ServicePrincipal;

export interface UserPrincipal {
  readonly kind: 'user';
  readonly userId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId?: string;
  /** For example "invoices:issue". Resolved by the gateway from the user's roles. */
  readonly permissions: readonly string[];
  /** The service that minted the token. */
  readonly issuer: string;
  /** The token's unique id (jti), for audit and log correlation. */
  readonly tokenId: string;
}

export interface ServicePrincipal {
  readonly kind: 'service';
  /** The calling service: "sales". */
  readonly service: string;
  /** What the caller asked to do, each one declared in its manifest: "contacts:read". */
  readonly scopes: readonly string[];
  readonly tokenId: string;
}

/**
 * Which scopes each service may put in a service token. Built from the
 * product manifests (`coreScopes`).
 *
 * A token is refused if it carries a scope its issuer did not declare. So a
 * compromised or buggy service cannot grant itself access by writing a wider
 * scope into its own token: the callee checks the claim against what the
 * caller's manifest says, not against the token alone.
 */
export interface ServiceScopeRegistry {
  declares(service: string, scope: string): boolean;
}

const SCOPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*:[a-z][a-z0-9_-]*$/;

/** True for a scope such as "contacts:read" or "ledger.postings:request". */
export const isScope = (value: unknown): value is string =>
  typeof value === 'string' && SCOPE.test(value);

/**
 * @param declarations service name -> the scopes its manifest declares.
 * Throws when a scope is not of the form "resource:action".
 */
export const createServiceScopeRegistry = (
  declarations: Readonly<Record<string, readonly string[]>>,
): ServiceScopeRegistry => {
  const declared = new Map<string, ReadonlySet<string>>();
  for (const [service, scopes] of Object.entries(declarations)) {
    for (const scope of scopes) {
      if (!isScope(scope)) {
        throw new Error(
          `Service "${service}" declares a scope that is not of the form resource:action.`,
        );
      }
    }
    declared.set(service, new Set(scopes));
  }
  return {
    declares: (service, scope) => declared.get(service)?.has(scope) ?? false,
  };
};
