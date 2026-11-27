import type {
  HealthRegistry,
  HealthReport,
  Metrics,
} from '@hk/platform/observability';
import {
  Controller,
  Get,
  Header,
  Inject,
  Module,
  Res,
  type DynamicModule,
} from '@nestjs/common';
import { HEALTH_REGISTRY, METRICS } from './tokens';

/** The one method of the framework's response object that these controllers use. */
interface StatusSetter {
  status(code: number): unknown;
}

/**
 * GET /health/live   200 while the process works. A failure means "restart me".
 * GET /health/ready  200 when dependencies answer, 503 when one does not.
 *
 * The body lists each check with ok, failed or timeout, and nothing else:
 * these endpoints are open, and error text can hold connection details.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HEALTH_REGISTRY) private readonly registry: HealthRegistry,
  ) {}

  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<HealthReport> {
    return this.respond('liveness', response);
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  ready(
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<HealthReport> {
    return this.respond('readiness', response);
  }

  private async respond(
    kind: 'liveness' | 'readiness',
    response: StatusSetter,
  ): Promise<HealthReport> {
    const report = await this.registry.run(kind);
    response.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}

/** GET /metrics in the Prometheus text format. */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(
    @Res({ passthrough: true })
    response: {
      setHeader(name: string, value: string): unknown;
    },
  ): Promise<string> {
    const { contentType, body } = await this.metrics.render();
    response.setHeader('Content-Type', contentType);
    return body;
  }
}

export interface ObservabilityModuleOptions {
  health: HealthRegistry;
  /** Leave out for a service that does not expose /metrics. */
  metrics?: Metrics;
}

/**
 * Adds the health endpoints, and /metrics when a Metrics instance is given.
 *
 * In production these paths must not be reachable from the internet: the
 * gateway does not route them, and only the cluster's probes and the metrics
 * scraper call them.
 */
@Module({})
export class ObservabilityModule {
  static register(options: ObservabilityModuleOptions): DynamicModule {
    return {
      module: ObservabilityModule,
      controllers: options.metrics
        ? [HealthController, MetricsController]
        : [HealthController],
      providers: [
        { provide: HEALTH_REGISTRY, useValue: options.health },
        ...(options.metrics
          ? [{ provide: METRICS, useValue: options.metrics }]
          : []),
      ],
    };
  }
}
