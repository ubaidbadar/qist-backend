import * as contracts from '../controllers/contracts_controller';
import * as locks from '../controllers/locks_controller';
import * as payments from '../controllers/payments_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

export const contractRoutes = authedRouter()
  .get('/', ...contracts.list)
  .get('/:id', ...contracts.show)
  .post('/', requirePermission('contracts.create'), ...contracts.create)
  .post('/:id/cancel', requirePermission('contracts.cancel'), ...contracts.cancel)
  .get('/:id/payments', ...payments.ledger)
  .post('/:id/payments', requirePermission('payments.record'), ...payments.record)
  .post('/:id/lock', requirePermission('locks.manage'), ...locks.lock)
  .post('/:id/unlock', requirePermission('locks.manage'), ...locks.unlock)
  .post('/:id/pause', requirePermission('locks.manage'), ...locks.pause);
