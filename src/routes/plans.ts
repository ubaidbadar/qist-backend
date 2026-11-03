import * as plans from '../controllers/plans_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

export const planRoutes = authedRouter()
  .get('/', ...plans.list)
  .post('/', requirePermission('org.manage'), ...plans.create)
  .patch('/:id', requirePermission('org.manage'), ...plans.update);
