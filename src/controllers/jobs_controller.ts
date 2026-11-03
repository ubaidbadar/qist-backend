import { timingSafeEqual } from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { UnauthorizedError, NotFoundError } from '../lib/errors';
import { parseId } from '../lib/ids';
import { publicController } from '../lib/factory';
import { runAutoLock } from '../jobs/auto_lock_job';
import { withJobLease } from '../jobs/lease';
import { runOverdueCheck } from '../jobs/overdue_job';

const JOBS = {
  overdue: (orgId?: Types.ObjectId) => runOverdueCheck(new Date(), { orgId }),
  'auto-lock': (orgId?: Types.ObjectId) => runAutoLock(new Date(), { anyHour: true, orgId }),
};

const secretMatches = (given: string) => {
  const expected = Buffer.from(`Bearer ${env.INTERNAL_JOB_SECRET}`);
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/** POST /internal/jobs/:name with `Authorization: Bearer <INTERNAL_JOB_SECRET>`: for an external scheduler or a manual run. */
export const run = publicController.createHandlers(async (c) => {
  if (!secretMatches(c.req.header('Authorization') ?? '')) throw new UnauthorizedError();
  const name = c.req.param('name') as keyof typeof JOBS;
  const job = JOBS[name];
  if (!job) throw new NotFoundError('Job');

  const orgIdParam = c.req.query('orgId');
  const orgId = orgIdParam ? parseId(orgIdParam, 'Org') : undefined;
  const leaseKey = orgId ? `${name}:${orgId}` : name;

  const ran = await withJobLease(leaseKey, async () => {
    await job(orgId);
  });
  return c.json({ data: { job: name, ran } });
});
