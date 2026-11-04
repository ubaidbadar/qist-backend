import * as dashboard from '../controllers/dashboard_controller';
import { authedRouter } from '../middleware/authenticate';

/** All dashboard panels are derived from this one tenant-scoped snapshot. */
export const dashboardRoutes = authedRouter().get('/', ...dashboard.show);
