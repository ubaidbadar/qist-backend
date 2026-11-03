import * as locks from '../controllers/locks_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

export const commandRoutes = authedRouter()
  .get('/', ...locks.listCommands)
  .post('/:id/approve', requirePermission('locks.manage'), ...locks.approve)
  .post('/:id/cancel', requirePermission('locks.manage'), ...locks.cancelCommand);

export const lockRoutes = authedRouter().get('/overdue', ...locks.overdue);
