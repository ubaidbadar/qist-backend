import * as jobs from '../controllers/jobs_controller';
import { createRouter } from '../lib/hono';

/** Not for the portal: called by schedulers with the internal job secret. */
export const internalRoutes = createRouter().post('/jobs/:name', ...jobs.run);
