import { runDocumentJobs } from '../documents/process_jobs';
import { deliverCustomerNotifications, sendCustomerDueReminders } from '../lib/customer_notifications';
import { SHOP_TIME_ZONE } from '@shop/shared';
import { logger } from '../lib/logger';
import { runAutoLock } from './auto_lock_job';
import { withJobLease } from './lease';
import { runOverdueCheck } from './overdue_job';

/** A failed run is logged and retried at the next tick; it never stops the server. */
const safely = (name: string, job: () => Promise<unknown>) => () =>
  withJobLease(name, async () => {
    await job();
  }).catch((err: unknown) => logger.error('Job failed', { job: name, err }));

/**
 * In-process schedule (Bun.cron, Pakistan time) for a single long-running container. With several instances the
 * leases keep each run to one of them; an external scheduler can call /api/v1/internal/jobs/:name instead.
 */
export function scheduleJobs() {
  Bun.cron('5 0 * * *', safely('overdue', () => runOverdueCheck()), { tz: SHOP_TIME_ZONE });
  Bun.cron('0 * * * *', safely('auto-lock', () => runAutoLock()), { tz: SHOP_TIME_ZONE });
  Bun.cron('* * * * *', safely('documents', runDocumentJobs), { tz: SHOP_TIME_ZONE });
  Bun.cron('* * * * *', safely('customer-push', deliverCustomerNotifications), { tz: SHOP_TIME_ZONE });
  Bun.cron('0 9 * * *', safely('customer-due', sendCustomerDueReminders), { tz: SHOP_TIME_ZONE });
  logger.info('Jobs scheduled', { overdue: '00:05 daily', autoLock: 'hourly, at each retailer’s lock hour' });
}
