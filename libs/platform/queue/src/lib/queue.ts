import { runWithLogContext, type Logger } from '@hk/platform/logger';
import type { RedisClient } from '@hk/platform/redis';
import { Queue, UnrecoverableError, Worker, type JobsOptions } from 'bullmq';

/** Every BullMQ key in Redis starts with this. */
export const QUEUE_PREFIX = 'hk';

const NAME_PART = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The name of a queue: `<service>.<topic>`, for example `core.posting`.
 * Lower-case letters, digits and hyphens only. BullMQ does not allow a colon.
 */
export const queueName = (service: string, topic: string): string => {
  if (!NAME_PART.test(service) || !NAME_PART.test(topic)) {
    throw new Error(
      'Queue service and topic must be lower-case letters, digits and hyphens.',
    );
  }
  return `${service}.${topic}`;
};

/**
 * 5 attempts with exponential back-off (1s, 2s, 4s, 8s), which rides out a
 * short outage of a dependency. Finished jobs are trimmed so Redis does not
 * grow without bound; failed ones are kept a week for investigation.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

/**
 * Throw this from a handler when retrying cannot help, for example when the
 * job's data is invalid. The job fails at once and is not retried.
 */
export class NonRetryableJobError extends UnrecoverableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'NonRetryableJobError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface EnqueueOptions {
  /**
   * Makes the enqueue idempotent: a second job with the same id is ignored
   * while the first is still known to the queue. Use the outbox event id.
   * Must not contain a colon.
   */
  jobId?: string;
  delayMs?: number;
  /** Overrides the default of 5. */
  attempts?: number;
}

export interface JobQueue<Data> {
  readonly name: string;
  enqueue(
    jobName: string,
    data: Data,
    options?: EnqueueOptions,
  ): Promise<{ id: string }>;
  /** Jobs per state, for metrics and tests. */
  counts(): Promise<Record<string, number>>;
  /** Removes the queue and all its jobs from Redis. For tests. */
  destroy(): Promise<void>;
  close(): Promise<void>;
}

export interface QueueOptions {
  /** From queueName(). */
  name: string;
  /** A connection created with purpose "queue". */
  connection: RedisClient;
  jobOptions?: JobsOptions;
}

export const createQueue = <Data>(options: QueueOptions): JobQueue<Data> => {
  const queue = new Queue(options.name, {
    connection: options.connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...options.jobOptions },
  });

  return {
    name: options.name,
    enqueue: async (jobName, data, enqueueOptions = {}) => {
      if (enqueueOptions.jobId?.includes(':')) {
        throw new Error('A job id must not contain a colon.');
      }
      const job = await queue.add(jobName, data, {
        ...(enqueueOptions.jobId === undefined
          ? {}
          : { jobId: enqueueOptions.jobId }),
        ...(enqueueOptions.delayMs === undefined
          ? {}
          : { delay: enqueueOptions.delayMs }),
        ...(enqueueOptions.attempts === undefined
          ? {}
          : { attempts: enqueueOptions.attempts }),
      });
      return { id: String(job.id) };
    },
    counts: () => queue.getJobCounts(),
    destroy: async () => {
      await queue.obliterate({ force: true });
    },
    close: () => queue.close(),
  };
};

export interface JobContext<Data> {
  id: string;
  name: string;
  data: Data;
  /** 1 on the first try. */
  attempt: number;
  maxAttempts: number;
}

export type JobHandler<Data> = (job: JobContext<Data>) => Promise<void>;

export interface WorkerOptions<Data> {
  name: string;
  /** A connection created with purpose "queue". */
  connection: RedisClient;
  handler: JobHandler<Data>;
  logger: Logger;
  /** Jobs handled at the same time by this process. Defaults to 5. */
  concurrency?: number;
}

export interface JobWorker {
  /** Resolves once the worker is connected and taking jobs. */
  ready(): Promise<void>;
  /** Stops taking jobs and waits for the running ones to finish. */
  close(): Promise<void>;
}

/**
 * Starts handling the jobs of one queue.
 *
 * A handler must be idempotent: BullMQ delivers a job at least once, and a
 * job whose worker died mid-way is run again. Consumers of events get that
 * from the inbox (platform/inbox).
 *
 * Each job runs inside a log context with the queue, job id, job name and
 * attempt, so every line the handler logs can be traced to its job. Job data
 * is never logged.
 */
export const createWorker = <Data>(options: WorkerOptions<Data>): JobWorker => {
  const { logger, name } = options;

  const worker = new Worker(
    name,
    async (job) => {
      const context: JobContext<Data> = {
        id: String(job.id),
        name: job.name,
        data: job.data as Data,
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? 1,
      };
      await runWithLogContext(
        {
          queue: name,
          jobId: context.id,
          jobName: context.name,
          attempt: context.attempt,
        },
        () => options.handler(context),
      );
    },
    {
      connection: options.connection,
      prefix: QUEUE_PREFIX,
      concurrency: options.concurrency ?? 5,
    },
  );

  worker.on('completed', (job) => {
    logger.debug('job completed', { queue: name, jobId: String(job.id) });
  });
  worker.on('failed', (job, err) => {
    const attempts = job?.opts.attempts ?? 1;
    const exhausted =
      err instanceof UnrecoverableError ||
      (job?.attemptsMade ?? attempts) >= attempts;
    const fields = {
      queue: name,
      jobId: job ? String(job.id) : undefined,
      jobName: job?.name,
      attempt: job?.attemptsMade,
      err,
    };
    if (exhausted) {
      logger.error('job failed permanently', fields);
    } else {
      logger.warn('job failed, will retry', fields);
    }
  });
  worker.on('error', (err) => {
    logger.warn('queue worker error', { queue: name, err });
  });

  return {
    ready: async () => {
      await worker.waitUntilReady();
    },
    close: () => worker.close(),
  };
};
