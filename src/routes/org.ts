import * as org from '../controllers/org_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

export const orgRoutes = authedRouter()
  .get('/', ...org.show)
  .patch('/settings', requirePermission('org.manage'), ...org.updateSettings)
  .get('/documents', requirePermission('org.manage'), ...org.documentSettings)
  .patch('/documents', requirePermission('org.manage'), ...org.updateDocumentSettings)
  .patch('/', requirePermission('org.manage'), ...org.update)
  .patch('/logo', requirePermission('org.manage'), ...org.updateLogo)
  .patch('/payment-methods', requirePermission('org.manage'), ...org.updatePaymentMethods)
  .patch('/policy', requirePermission('org.manage'), ...org.updatePolicy);
