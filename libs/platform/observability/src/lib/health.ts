/**
 * liveness   Is this process working at all? A failure means "restart me".
 *            Never check a dependency here: a database outage must not make
 *            the orchestrator kill every pod.
 * readiness  Can this process serve traffic right now? A failure means "stop
 *            sending me requests until I recover". Dependencies go here.
 */
export type HealthKind = 'liveness' | 'readiness';

export interface HealthCheck {
  /** Short and stable: "postgres", "redis". Shown in the report. */
  name: string;
  kind: HealthKind;
  /** Resolves when healthy, throws or rejects when not. */
  check: () => Promise<unknown> | unknown;
  /** Defaults to 2000. A check that takes longer counts as failed. */
  timeoutMs?: number;
}

export type CheckOutcome = 'ok' | 'failed' | 'timeout';

export interface HealthReport {
  status: 'ok' | 'error';
  checks: Record<string, { status: CheckOutcome; durationMs: number }>;
}

export interface HealthRegistryOptions {
  /**
   * Told about every failing check, with the real error. Log it here: the
   * report itself never contains error text, because /health is reachable
   * without authentication and errors can hold connection details.
   */
  onFailure?: (
    check: { name: string; kind: HealthKind },
    error: unknown,
  ) => void;
  /** For tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

class CheckTimeout extends Error {}

/**
 * Holds the health checks of one service. Framework-free: platform/nest
 * exposes it over HTTP, a worker without HTTP can call it directly.
 */
export class HealthRegistry {
  private readonly checks: HealthCheck[] = [];
  private readonly onFailure: NonNullable<HealthRegistryOptions['onFailure']>;
  private readonly now: () => number;

  constructor(options: HealthRegistryOptions = {}) {
    this.onFailure = options.onFailure ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  register(check: HealthCheck): this {
    if (this.checks.some((existing) => existing.name === check.name)) {
      throw new Error(`Health check "${check.name}" is already registered.`);
    }
    this.checks.push(check);
    return this;
  }

  /** Runs every check of the given kind at the same time. With none registered the status is ok. */
  async run(kind: HealthKind): Promise<HealthReport> {
    const selected = this.checks.filter((check) => check.kind === kind);
    const outcomes = await Promise.all(
      selected.map((check) => this.runOne(check)),
    );
    const report: HealthReport = { status: 'ok', checks: {} };
    selected.forEach((check, index) => {
      const outcome = outcomes[index] as HealthReport['checks'][string];
      report.checks[check.name] = outcome;
      if (outcome.status !== 'ok') {
        report.status = 'error';
      }
    });
    return report;
  }

  private async runOne(
    check: HealthCheck,
  ): Promise<HealthReport['checks'][string]> {
    const startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => check.check()),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new CheckTimeout()),
            check.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          );
        }),
      ]);
      return { status: 'ok', durationMs: this.now() - startedAt };
    } catch (error) {
      this.onFailure({ name: check.name, kind: check.kind }, error);
      return {
        status: error instanceof CheckTimeout ? 'timeout' : 'failed',
        durationMs: this.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
