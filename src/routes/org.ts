import * as org from '../controllers/org_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

export const orgRoutes = authedRouter()
  .get('/', ...org.show)
  .patch('/', requirePermission('org.manage'), ...org.update)
  .patch('/payment-methods', requirePermission('org.manage'), ...org.updatePaymentMethods)
  .patch('/policy', requirePermission('org.manage'), ...org.updatePolicy);
