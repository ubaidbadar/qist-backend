import * as users from '../controllers/users_controller';
import { authedRouter } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require_permission';

/** The team: owner only. A short, bounded list returned whole. */
export const userRoutes = authedRouter()
  .use(requirePermission('team.manage'))
  .get('/', ...users.list)
  .post('/', ...users.create)
  .patch('/:id', ...users.update)
  .patch('/:id/active', ...users.setActive)
  .post('/:id/temporary-password', ...users.issueTemporaryPassword);
