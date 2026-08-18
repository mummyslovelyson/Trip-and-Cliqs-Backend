/**
 * Lightweight in-process job queue for async tasks (emails, notifications).
 *
 * Jobs are added to an in-memory queue and processed with configurable
 * concurrency. Failed jobs are retried up to MAX_RETRIES times with
 * exponential backoff. No external dependencies (Redis, RabbitMQ) needed.
 *
 * Env vars (all optional):
 *   JOB_QUEUE_CONCURRENCY  — max parallel jobs (default 3)
 *   JOB_QUEUE_MAX_RETRIES  — retry attempts per job (default 3)
 */

const CONCURRENCY = parseInt(process.env.JOB_QUEUE_CONCURRENCY, 10) || 3;
const MAX_RETRIES = parseInt(process.env.JOB_QUEUE_MAX_RETRIES, 10) || 3;

const queue = [];        // { id, handler, args, retries, nextRun }
const processing = new Set();
let jobId = 0;

const enqueue = (handler, args = {}, opts = {}) => {
  const id = ++jobId;
  queue.push({
    id,
    handler,
    args,
    label: opts.label || 'job',
    retries: 0,
    nextRun: Date.now(),
  });
  drain();
  return id;
};

const drain = () => {
  while (processing.size < CONCURRENCY) {
    const job = queue.find((j) => j.nextRun <= Date.now());
    if (!job) break;

    queue.splice(queue.indexOf(job), 1);
    processing.add(job.id);
    run(job).finally(() => {
      processing.delete(job.id);
      drain();
    });
  }
};

const run = async (job) => {
  try {
    await job.handler(job.args);
  } catch (err) {
    job.retries += 1;
    if (job.retries <= MAX_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, job.retries - 1), 30_000);
      job.nextRun = Date.now() + delay;
      queue.push(job);
      console.warn(`[jobQueue] retrying "${job.label}" (attempt ${job.retries}/${MAX_RETRIES}) in ${delay}ms`);
    } else {
      console.error(`[jobQueue] "${job.label}" failed after ${MAX_RETRIES} retries:`, err.message);
    }
  }
};

export const queueEmail = (mailFn) => {
  return (payload) => enqueue(mailFn, payload, { label: `email:${payload.to || 'unknown'}` });
};

export const queueNotification = (notifyFn) => {
  return (payload) => enqueue(notifyFn, payload, { label: `notif:${payload.userId || 'bulk'}` });
};

// Direct enqueue for ad-hoc jobs.
export { enqueue as queueJob };

// Introspection (useful for health checks).
export const queueStats = () => ({
  pending: queue.length,
  processing: processing.size,
  concurrency: CONCURRENCY,
});

export default { enqueue, queueEmail, queueNotification, queueStats };
