import type { Idempotency } from '@hk/platform/idempotency';
import {
  Inject,
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { IDEMPOTENCY } from './tokens';

/**
 * CONTRACT ONLY. Failure-path tests first (plan row 1.4, a money-path row).
 * The two decorators below only record metadata and are real. The
 * interceptor and findUncoveredRoutes() are not implemented yet: they throw.
 * The tests in idempotent.spec.ts are marked `it.failing` until the
 * implementation lands, and they are not to be changed to make it pass.
 */

export const IDEMPOTENT_METADATA = 'hk:idempotent';
export const IDEMPOTENCY_EXEMPT_METADATA = 'hk:idempotency-exempt';

/**
 * Marks a handler that changes state. With IdempotencyInterceptor installed,
 * the handler then runs at most once per Idempotency-Key:
 *
 *   @Post()
 *   @Idempotent()
 *   create(@Body(new ZodValidationPipe(schema)) input: CreateInvoice) {}
 *
 * - The request must carry an Idempotency-Key header, or it is answered 400.
 * - The handler runs inside the transaction that also records the key, so
 *   its writes and "this key is done" commit together.
 * - A repeat of the same request gets the stored response, with the header
 *   `Idempotent-Replayed: true`, and the handler does not run.
 * - The same key with a different request is answered 422, and a repeat that
 *   arrives while the first is still running is answered 409.
 *
 * "The same request" means the same HTTP method, route, path parameters,
 * query and body.
 */
export const Idempotent = (): MethodDecorator =>
  SetMetadata(IDEMPOTENT_METADATA, true);

/**
 * Marks a state-changing handler that deliberately does not use an
 * idempotency key, and says why:
 *
 *   @Post('webhooks/mtn')
 *   @IdempotencyExempt('deduplicated on the provider reference')
 *
 * The reason is required. It is what a reviewer reads.
 */
export const IdempotencyExempt = (reason: string): MethodDecorator =>
  SetMetadata(IDEMPOTENCY_EXEMPT_METADATA, reason);

/**
 * Enforces @Idempotent(). Install it for the whole app, with the service's
 * Idempotency instance provided under the IDEMPOTENCY token:
 *
 *   providers: [
 *     { provide: IDEMPOTENCY, useValue: idempotency },
 *     { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
 *   ]
 *
 * It fails closed. A POST, PUT, PATCH or DELETE handler that carries neither
 * @Idempotent() nor @IdempotencyExempt() is answered 500 and does not run.
 * GET, HEAD and OPTIONS handlers pass through untouched.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY) protected readonly idempotency: Idempotency,
    protected readonly reflector: Reflector,
  ) {}

  intercept(
    _context: ExecutionContext,
    _next: CallHandler,
  ): Observable<unknown> {
    throw new Error(
      'IdempotencyInterceptor is not implemented yet (plan row 1.4).',
    );
  }
}

export interface UncoveredRoute {
  controller: string;
  handler: string;
  /** POST, PUT, PATCH or DELETE. */
  method: string;
  /** The problem: no decorator, both decorators, or an empty exemption reason. */
  problem: string;
}

/** A controller class, as listed in a Nest module's `controllers`. */
export type ControllerClass = abstract new (...args: never[]) => unknown;

/**
 * Lists every state-changing route handler that does not declare its
 * idempotency. An empty result means every POST, PUT, PATCH and DELETE
 * handler carries exactly one of @Idempotent() and @IdempotencyExempt(reason).
 *
 * Each service has a test that calls this with all of its controllers, so a
 * new write endpoint without a decision fails CI.
 */
export const findUncoveredRoutes = (
  _controllers: readonly ControllerClass[],
): UncoveredRoute[] => {
  throw new Error('findUncoveredRoutes is not implemented yet (plan row 1.4).');
};
