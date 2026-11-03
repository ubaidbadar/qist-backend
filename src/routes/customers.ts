import * as customers from '../controllers/customers_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

export const customerRoutes = authedRouter()
  .get('/', ...customers.list)
  .get('/:id', ...customers.show)
  .post('/', requirePermission('customers.write'), ...customers.create)
  .patch('/:id', requirePermission('customers.write'), ...customers.update)
  .delete('/:id', requirePermission('customers.delete'), ...customers.remove);
