import * as payments from '../controllers/payments_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

export const paymentRoutes = authedRouter()
  .get('/', ...payments.list)
  .get('/collections', ...payments.collections)
  .get('/:id', ...payments.show)
  .post('/:id/void', requirePermission('payments.void'), ...payments.voidPayment);
