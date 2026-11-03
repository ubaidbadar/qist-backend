import { JobLock } from '../models/job_lock';
import { logger } from '../lib/logger';

const LEASE_MS = 30 * 60 * 1000;

/**
 * Runs `job` only if no other instance holds its lease. The lease expires by itself, so a crashed run never blocks
 * the next one for long. Returns false when another instance is running it.
 */
export async function withJobLease(name: string, job: () => Promise<void>) {
  const now = new Date();
  try {
    await JobLock.findOneAndUpdate({ _id: name, lockedUntil: { $lt: now } }, { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS) } }, { upsert: true });
  } catch (err) {
    // The lease is held: the filter missed and the upsert hit the existing _id.
    if (err instanceof Error && 'code' in err && err.code === 11000) {
      logger.info('Job skipped: running elsewhere', { job: name });
      return false;
    }
    throw err;
  }
  try {
    await job();
    return true;
  } finally {
    await JobLock.updateOne({ _id: name }, { $set: { lockedUntil: new Date(0) } });
  }
}
