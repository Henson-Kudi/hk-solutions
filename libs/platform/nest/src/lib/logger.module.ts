import type { Logger } from '@hk/platform/logger';
import { Module, type DynamicModule, type LoggerService } from '@nestjs/common';
import { LOGGER } from './tokens';

/**
 * Makes the service's logger injectable:
 *
 *   constructor(@Inject(LOGGER) private readonly logger: Logger) {}
 *
 * Not global on purpose. A module that logs imports LoggerModule.register(logger),
 * so its dependencies stay visible.
 */
@Module({})
export class LoggerModule {
  static register(logger: Logger): DynamicModule {
    return {
      module: LoggerModule,
      providers: [{ provide: LOGGER, useValue: logger }],
      exports: [LOGGER],
    };
  }
}

const describe = (message: unknown): string =>
  typeof message === 'string' ? message : 'nest message';

const contextOf = (optional: unknown[]): string | undefined => {
  const last = optional[optional.length - 1];
  return typeof last === 'string' ? last : undefined;
};

/**
 * Routes Nest's own messages (module loaded, route mapped, …) into the
 * platform logger, so a service writes one log format:
 *
 *   NestFactory.create(AppModule, { logger: new NestLoggerAdapter(logger) })
 *
 * Application code does not use this. It injects LOGGER.
 */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.logger.info(describe(message), { context: contextOf(optional) });
  }

  error(message: unknown, ...optional: unknown[]): void {
    // Nest passes (message, stack, context) or (message, context).
    const stack =
      optional.length > 1 && typeof optional[0] === 'string'
        ? optional[0]
        : undefined;
    this.logger.error(describe(message), {
      context: contextOf(optional),
      ...(message instanceof Error ? { err: message } : {}),
      ...(stack === undefined ? {} : { stack }),
    });
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn(describe(message), { context: contextOf(optional) });
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug(describe(message), { context: contextOf(optional) });
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.trace(describe(message), { context: contextOf(optional) });
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    this.logger.fatal(describe(message), { context: contextOf(optional) });
  }
}
