import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithTenantContext } from '@hk/platform/db';
import { AppError, permissionDenied } from '@hk/platform/errors';
import { runWithLogContext, type Logger } from '@hk/platform/logger';
import {
  Injectable,
  SetMetadata,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Principal } from './principal';
import { TokenError, type TokenVerifier } from './tokens';

/** What the middleware learned about the request. Read by the guard and by @CurrentPrincipal(). */
type AuthState =
  | { status: 'anonymous' }
  | { status: 'authenticated'; principal: Principal }
  | { status: 'rejected'; error: TokenError };

interface AuthenticatedRequest extends IncomingMessage {
  hkAuth?: AuthState;
}

type Next = (error?: unknown) => void;

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

export interface InternalAuthOptions {
  verifier: TokenVerifier;
  logger: Logger;
}

/**
 * Verifies the bearer token of every request, and runs the rest of the
 * request as that caller.
 *
 * For a user it starts the tenant context from the token, so everything
 * below, including the database's row-level security, is scoped to the
 * user's business without any handler passing ids around. It also puts the
 * caller on every log line.
 *
 * This middleware never refuses a request itself. It records what it found,
 * and InternalAuthGuard decides, because only a guard knows whether the route
 * is @Public(). It is middleware because the tenant context must wrap the
 * whole request: guards, pipes, interceptors and filters.
 *
 *   app.use(requestContext());
 *   app.use(internalAuth({ verifier, logger }));
 */
export const internalAuth = (options: InternalAuthOptions) => {
  const { verifier, logger } = options;

  return (
    request: AuthenticatedRequest,
    _response: ServerResponse,
    next: Next,
  ) => {
    const header = request.headers.authorization;
    if (header === undefined) {
      request.hkAuth = { status: 'anonymous' };
      next();
      return;
    }
    const token = BEARER.exec(header)?.[1];

    verifier.verify(token).then(
      (principal) => {
        request.hkAuth = { status: 'authenticated', principal };
        if (principal.kind === 'user') {
          runWithTenantContext(
            {
              tenantId: principal.tenantId,
              businessId: principal.businessId,
              userId: principal.userId,
              ...(principal.branchId === undefined
                ? {}
                : { branchId: principal.branchId }),
            },
            () =>
              runWithLogContext(
                {
                  tenantId: principal.tenantId,
                  businessId: principal.businessId,
                  userId: principal.userId,
                },
                () => next(),
              ),
          );
        } else {
          runWithLogContext({ callerService: principal.service }, () => next());
        }
      },
      (error: unknown) => {
        const rejection =
          error instanceof TokenError
            ? error
            : new TokenError('malformed', error);
        request.hkAuth = { status: 'rejected', error: rejection };
        // The reason goes to the log, never to the caller.
        logger.warn('internal token rejected', { reason: rejection.reason });
        next();
      },
    );
  };
};

export const PUBLIC_METADATA = 'hk:public';
export const REQUIRED_SCOPES_METADATA = 'hk:required-scopes';
export const REQUIRED_PERMISSIONS_METADATA = 'hk:required-permissions';

/**
 * Marks a handler, or a whole controller, that needs no token: health
 * checks, provider webhooks (which authenticate by signature instead).
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_METADATA, true);

/**
 * The handler is for other services, and the caller's token must carry every
 * scope listed. A user token is refused.
 */
export const RequireScope = (
  ...scopes: string[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES_METADATA, scopes);

/**
 * The handler is for users, and the user must hold every permission listed.
 * A service token is refused.
 */
export const RequirePermission = (
  ...permissions: string[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS_METADATA, permissions);

/**
 * Decides whether the request may reach its handler. Install it for the
 * whole app:
 *
 *   providers: [{ provide: APP_GUARD, useClass: InternalAuthGuard }]
 *
 * It denies by default. A route is reachable without a valid token only if
 * it is marked @Public().
 *
 * - no token, or a refused one: 401
 * - @RequireScope and the caller is a user, or lacks a scope: 403
 * - @RequirePermission and the caller is a service, or lacks a permission: 403
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_METADATA, targets)) {
      return true;
    }

    const state = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().hkAuth;
    if (!state) {
      // Fail closed: without the middleware nobody was authenticated.
      throw new AppError(
        'INTERNAL_AUTH_NOT_INSTALLED',
        500,
        'InternalAuthGuard needs the internalAuth() middleware.',
      );
    }
    if (state.status === 'rejected') {
      throw state.error;
    }
    if (state.status === 'anonymous') {
      throw new TokenError('missing');
    }

    const { principal } = state;
    const scopes = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_SCOPES_METADATA,
      targets,
    );
    if (scopes) {
      if (
        principal.kind !== 'service' ||
        !scopes.every((scope) => principal.scopes.includes(scope))
      ) {
        throw permissionDenied();
      }
    }
    const permissions = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_PERMISSIONS_METADATA,
      targets,
    );
    if (permissions) {
      if (
        principal.kind !== 'user' ||
        !permissions.every((permission) =>
          principal.permissions.includes(permission),
        )
      ) {
        throw permissionDenied();
      }
    }
    return true;
  }
}

/**
 * Handler parameter that receives the verified caller:
 *
 *   @Get() list(@CurrentPrincipal() principal: Principal) {}
 *
 * Undefined on a @Public() route called without a token.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal | undefined => {
    const state = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().hkAuth;
    return state?.status === 'authenticated' ? state.principal : undefined;
  },
);
