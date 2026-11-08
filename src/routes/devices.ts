import * as devices from '../controllers/devices_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

export const deviceRoutes = authedRouter()
  .get('/', ...devices.list)
  .get('/:id', ...devices.get)
  .post('/', requirePermission('stock.write'), ...devices.create)
  .patch('/:id', requirePermission('stock.write'), ...devices.update)
  .post('/:id/transfer', requirePermission('stock.transfer'), ...devices.transfer)
  .post('/:id/enrollment', requirePermission('devices.enroll'), ...devices.issueEnrollment)
  .delete('/:id/enrollment', requirePermission('devices.enroll'), ...devices.revokeEnrollment)
  .delete('/:id', requirePermission('stock.delete'), ...devices.remove);
