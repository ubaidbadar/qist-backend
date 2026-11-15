import * as me from '../controllers/me_controller';
import { authedRouter } from '../middleware/authenticate';

/** The signed-in user's own account. */
export const meRoutes = authedRouter()
  .get('/', ...me.show)
  .post('/google', ...me.connectGoogle)
  .post('/password', ...me.changePassword)
  .post('/email-verification', ...me.resendVerification);
