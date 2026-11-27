import { createMemoryLogger, type MemoryLogger } from '@hk/platform/logger';
import { closeRedis, createRedis, type RedisClient } from '@hk/platform/redis';
import {
  NonRetryableJobError,
  createQueue,
  createWorker,
  queueName,
  type JobContext,
  type JobQueue,
  type JobWorker,
} from './queue';

/**
 * Tests that need a server run when HK_TEST_REDIS_URL is set:
 *   pnpm infra:up
 *   HK_TEST_REDIS_URL=redis://127.0.0.1:63790 pnpm nx test platform-queue
 */
const url = process.env['HK_TEST_REDIS_URL'];
const describeWithRedis = url ? describe : describe.skip;

describe('test setup', () => {
  it('has a Redis to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(url).toBeDefined();
    }
  });
});

describe('queueName', () => {
  it('joins service and topic with a dot', () => {
    expect(queueName('core', 'posting')).toBe('core.posting');
    expect(queueName('core-worker', 'outbox-relay')).toBe(
      'core-worker.outbox-relay',
    );
  });

  it.each([
    ['Core', 'posting'],
    ['core', 'post:ing'],
    ['core', ''],
    ['', 'posting'],
    ['core', 'post ing'],
    ['core.x', 'posting'],
    ['core', '-posting'],
  ])('refuses %p / %p', (service, topic) => {
    expect(() => queueName(service, topic)).toThrow(/lower-case/);
  });
});

describeWithRedis('against a real Redis', () => {
  interface Payload {
    invoiceId: string;
    secretNote?: string;
  }

  let connection: RedisClient;
  let queue: JobQueue<Payload>;
  let worker: JobWorker | undefined;
  let memory: MemoryLogger;
  let counter = 0;

  const until = async (condition: () => boolean, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error('condition not met in time');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeAll(() => {
    connection = createRedis({
      url: url as string,
      name: 'platform-queue-spec',
      purpose: 'queue',
    });
  });

  afterAll(async () => {
    await closeRedis(connection);
  });

  beforeEach(() => {
    counter += 1;
    memory = createMemoryLogger();
    queue = createQueue<Payload>({
      name: queueName('spec', `t${Date.now()}-${counter}`),
      connection,
      // Fast retries so the suite does not wait seconds for back-off.
      jobOptions: { backoff: { type: 'fixed', delay: 20 } },
    });
    worker = undefined;
  });

  afterEach(async () => {
    await worker?.close();
    await queue.destroy();
    await queue.close();
  });

  const start = async (
    handler: (job: JobContext<Payload>) => Promise<void>,
  ): Promise<void> => {
    worker = createWorker<Payload>({
      name: queue.name,
      connection,
      handler,
      logger: memory.logger,
    });
    await worker.ready();
  };

  it('delivers an enqueued job to the handler', async () => {
    const seen: JobContext<Payload>[] = [];
    await start(async (job) => {
      seen.push(job);
    });
    const { id } = await queue.enqueue('issue', { invoiceId: 'inv-1' });

    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({
      id,
      name: 'issue',
      data: { invoiceId: 'inv-1' },
      attempt: 1,
      maxAttempts: 5,
    });
  });

  it('retries a failing job, then succeeds', async () => {
    const attempts: number[] = [];
    await start(async (job) => {
      attempts.push(job.attempt);
      if (job.attempt < 3) {
        throw new Error('ledger unavailable');
      }
    });
    await queue.enqueue('post', { invoiceId: 'inv-2' });

    await until(() => attempts.length === 3);
    expect(attempts).toEqual([1, 2, 3]);
    await until(() =>
      memory.entries.some((entry) => entry.message === 'job completed'),
    );
    expect(
      memory.entries.filter(
        (entry) => entry.message === 'job failed, will retry',
      ),
    ).toHaveLength(2);
    expect(
      memory.entries.some(
        (entry) => entry.message === 'job failed permanently',
      ),
    ).toBe(false);
  });

  it('gives up after the last attempt and says so', async () => {
    let calls = 0;
    await start(async () => {
      calls += 1;
      throw new Error('still broken');
    });
    await queue.enqueue('post', { invoiceId: 'inv-3' }, { attempts: 2 });

    await until(() =>
      memory.entries.some(
        (entry) => entry.message === 'job failed permanently',
      ),
    );
    expect(calls).toBe(2);
    await expect(queue.counts()).resolves.toMatchObject({ failed: 1 });
  });

  it('does not retry a NonRetryableJobError', async () => {
    let calls = 0;
    await start(async () => {
      calls += 1;
      throw new NonRetryableJobError('payload is invalid');
    });
    await queue.enqueue('post', { invoiceId: 'inv-4' });

    await until(() =>
      memory.entries.some(
        (entry) => entry.message === 'job failed permanently',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(1);
  });

  it('ignores a second job with the same id', async () => {
    const first = await queue.enqueue(
      'post',
      { invoiceId: 'inv-5' },
      { jobId: 'event-1' },
    );
    const second = await queue.enqueue(
      'post',
      { invoiceId: 'inv-5' },
      { jobId: 'event-1' },
    );
    expect(second.id).toBe(first.id);
    await expect(queue.counts()).resolves.toMatchObject({ waiting: 1 });

    const seen: string[] = [];
    await start(async (job) => {
      seen.push(job.id);
    });
    await until(() => seen.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual(['event-1']);
  });

  it('refuses a job id with a colon', async () => {
    await expect(
      queue.enqueue('post', { invoiceId: 'x' }, { jobId: 'sales:invoice:1' }),
    ).rejects.toThrow(/colon/);
  });

  it('holds a delayed job back', async () => {
    const seen: number[] = [];
    await start(async () => {
      seen.push(Date.now());
    });
    const enqueuedAt = Date.now();
    await queue.enqueue('later', { invoiceId: 'inv-6' }, { delayMs: 300 });

    await until(() => seen.length === 1);
    expect((seen[0] as number) - enqueuedAt).toBeGreaterThanOrEqual(250);
  });

  it('tags handler log lines with the job, and never logs job data', async () => {
    let done = false;
    await start(async (job) => {
      memory.logger.info('handling');
      if (job.attempt === 1) {
        throw new Error('first try fails');
      }
      done = true;
    });
    const { id } = await queue.enqueue('issue', {
      invoiceId: 'inv-7',
      secretNote: 'do-not-log-me',
    });

    await until(() => done);
    const handling = memory.entries.filter(
      (entry) => entry.message === 'handling',
    );
    expect(handling[0]).toMatchObject({
      queue: queue.name,
      jobId: id,
      jobName: 'issue',
      attempt: 1,
    });
    expect(handling[1]).toMatchObject({ attempt: 2 });
    expect(memory.text()).not.toContain('do-not-log-me');
  });
});
