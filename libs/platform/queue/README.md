# @hk/platform/queue

Background jobs on BullMQ.

```ts
import { createQueue, createWorker, queueName } from '@hk/platform/queue';

const name = queueName('core', 'posting'); // "core.posting"

const queue = createQueue<PostingJob>({ name, connection });
await queue.enqueue('post-journal', { eventId }, { jobId: eventId });

const worker = createWorker<PostingJob>({
  name,
  connection,
  logger,
  handler: async (job) => {
    await postJournal(job.data);
  },
});

await worker.close(); // during shutdown: waits for running jobs
```

- `connection` comes from `createRedis({ purpose: 'queue' })`.
- **Handlers must be idempotent.** BullMQ delivers at least once, and a job whose worker died is run
  again. Event consumers get this from the inbox.
- **`jobId` makes an enqueue idempotent.** A second job with the same id is ignored while the first
  is known to the queue. It must not contain a colon.
- **Retries:** 5 attempts with exponential back-off (1s, 2s, 4s, 8s). Throw `NonRetryableJobError`
  when retrying cannot help, such as invalid job data.
- Each job runs in a log context with the queue, job id, job name and attempt. Job data is never
  logged.

## Tests

Most tests need a server and run only when `HK_TEST_REDIS_URL` is set:

```sh
pnpm infra:up
HK_TEST_REDIS_URL=redis://127.0.0.1:63790 pnpm nx test platform-queue
```
