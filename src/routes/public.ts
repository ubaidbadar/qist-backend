import * as orgLogo from '../controllers/org_logo_controller';
import { createRouter } from '../lib/hono';

/** Public assets that are intentionally safe to display without a user session. */
export const publicRoutes = createRouter().get('/orgs/:orgId/logo', ...orgLogo.show);
