import 'reflect-metadata';
import { AppError } from '@hk/platform/errors';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  type Idempotency,
} from '@hk/platform/idempotency';
import {
  Inject,
  Injectable,
  RequestMethod,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, throwError, type Observable } from 'rxjs';
import { IDEMPOTENCY } from './tokens';

/**
 * A money path (plan row 1.4). The tests in idempotent.spec.ts were written
 * and reviewed before this implementation, and are not to be changed to make
 * code pass. Changes here need Henson's line-by-line review.
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

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<IncomingRequest>();
    const method = (request.method ?? '').toUpperCase();
    if (!WRITE_METHODS.includes(method)) {
      return next.handle();
    }

    const handler = context.getHandler();
    const declaration = declarationOf(this.reflector, handler);
    if (declaration.problem !== undefined) {
      // Fail closed: a write whose idempotency nobody decided does not run.
      return throwError(
        () =>
          new AppError(
            'IDEMPOTENCY_NOT_DECLARED',
            500,
            'A write handler must carry exactly one of @Idempotent() and @IdempotencyExempt(reason).',
            { details: { problem: declaration.problem as string } },
          ),
      );
    }
    if (declaration.exempt) {
      return next.handle();
    }

    const header = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    // The route pattern, not the path: /payments/:id/capture. The values of
    // the parameters are part of the request below.
    const route = `${request.baseUrl ?? ''}${
      typeof request.route?.path === 'string' ? request.route.path : ''
    }`;
    // What Nest will answer with: the handler's @HttpCode, or its default.
    const status =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, handler) ??
      (method === 'POST' ? 201 : 200);

    const run = async (): Promise<unknown> => {
      const result = await this.idempotency.execute(
        {
          key: typeof header === 'string' ? header : undefined,
          operation: `${method} ${route}`,
          request: {
            params: request.params ?? {},
            query: request.query ?? {},
            body: request.body ?? null,
          },
        },
        // Subscribing here, inside execute's transaction, is what makes the
        // handler run in it: Nest calls the handler when next.handle() is
        // subscribed to.
        async () => ({
          status,
          body: await lastValueFrom(next.handle(), { defaultValue: null }),
        }),
      );
      if (result.replayed) {
        http
          .getResponse<OutgoingResponse>()
          .setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      }
      return result.response.body;
    };
    return from(run());
  }
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** The parts of an Express request and response this file uses. */
interface IncomingRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  baseUrl?: string;
  route?: { path?: unknown };
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

interface OutgoingResponse {
  setHeader(name: string, value: string): unknown;
}

const NO_DECLARATION =
  'has neither @Idempotent() nor @IdempotencyExempt(reason)';
const BOTH_DECLARATIONS =
  'has both @Idempotent() and @IdempotencyExempt(reason)';
const EMPTY_REASON = '@IdempotencyExempt needs a reason';

/** What a handler declared, and what is wrong with it if anything. */
const declarationOf = (
  reflector: Reflector,
  // A route handler as Nest and Reflect see it.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  handler: Function,
): { exempt: boolean; problem?: string } => {
  const idempotent =
    reflector.get<unknown>(IDEMPOTENT_METADATA, handler) === true;
  const reason = reflector.get<unknown>(IDEMPOTENCY_EXEMPT_METADATA, handler);
  if (idempotent && reason !== undefined) {
    return { exempt: false, problem: BOTH_DECLARATIONS };
  }
  if (idempotent) {
    return { exempt: false };
  }
  if (reason === undefined) {
    return { exempt: false, problem: NO_DECLARATION };
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { exempt: true, problem: EMPTY_REASON };
  }
  return { exempt: true };
};

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
  controllers: readonly ControllerClass[],
): UncoveredRoute[] => {
  const reflector = new Reflector();
  const uncovered: UncoveredRoute[] = [];

  for (const controller of controllers) {
    const seen = new Set<string>();
    // Walk up the class chain, so handlers inherited from a base controller count.
    for (
      let prototype: object | null = controller.prototype as object;
      prototype !== null && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === 'constructor' || seen.has(name)) {
          continue;
        }
        seen.add(name);
        const member = Object.getOwnPropertyDescriptor(prototype, name)?.value;
        if (typeof member !== 'function') {
          continue;
        }
        // Set by @Get(), @Post() and friends. Absent on a plain method.
        const verb = Reflect.getMetadata(METHOD_METADATA, member) as
          | RequestMethod
          | undefined;
        if (verb === undefined) {
          continue;
        }
        const method = RequestMethod[verb];
        // @All() also accepts writes.
        if (!WRITE_METHODS.includes(method) && method !== 'ALL') {
          continue;
        }
        const { problem } = declarationOf(reflector, member);
        if (problem !== undefined) {
          uncovered.push({
            controller: controller.name,
            handler: name,
            method,
            problem,
          });
        }
      }
    }
  }
  return uncovered;
};
