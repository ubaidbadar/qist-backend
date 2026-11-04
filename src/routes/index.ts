import { createRouter } from '../lib/hono';
import { authRoutes } from './auth';
import { branchRoutes } from './branches';
import { commandRoutes, lockRoutes } from './commands';
import { deviceApiRoutes } from './device';
import { dashboardRoutes } from './dashboard';
import { internalRoutes } from './internal';
import { contractRoutes } from './contracts';
import { customerRoutes } from './customers';
import { deviceRoutes } from './devices';
import { meRoutes } from './me';
import { orgRoutes } from './org';
import { paymentRoutes } from './payments';
import { planRoutes } from './plans';
import { userRoutes } from './users';

/** Every endpoint under /api/v1. Each router is either public or wholly behind `authenticate`. */
export const apiRoutes = createRouter()
  .route('/auth', authRoutes)
  .route('/me', meRoutes)
  .route('/org', orgRoutes)
  .route('/branches', branchRoutes)
  .route('/users', userRoutes)
  .route('/customers', customerRoutes)
  .route('/devices', deviceRoutes)
  .route('/dashboard', dashboardRoutes)
  .route('/plans', planRoutes)
  .route('/contracts', contractRoutes)
  .route('/payments', paymentRoutes)
  .route('/commands', commandRoutes)
  .route('/locks', lockRoutes)
  .route('/device', deviceApiRoutes)
  .route('/internal', internalRoutes);
