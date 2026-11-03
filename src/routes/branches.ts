import * as branches from '../controllers/branches_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

/** A short, bounded list: returned whole rather than in pages. */
export const branchRoutes = authedRouter()
  .get('/', ...branches.list)
  .post('/', requirePermission('org.manage'), ...branches.create)
  .patch('/:id', requirePermission('org.manage'), ...branches.update);
