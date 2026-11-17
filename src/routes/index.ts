import { createRouter } from '../lib/hono';
import { staffDocumentRoutes } from '../documents/routes';
import { documentStorageReady } from '../documents/storage';
import { authRoutes } from './auth';
import { branchRoutes } from './branches';
import { commandRoutes, lockRoutes } from './commands';
import { deviceApiRoutes } from './device';
import { dashboardRoutes } from './dashboard';
import { internalRoutes } from './internal';
import { contractRoutes } from './contracts';
import { customerRoutes } from './customers';
import { customerAppRoutes } from './customer_app';
import { deviceRoutes } from './devices';
import { meRoutes } from './me';
import { orgRoutes } from './org';
import { paymentRoutes } from './payments';
import { planRoutes } from './plans';
import { userRoutes } from './users';
import { publicRoutes } from './public';

/** Every endpoint under /api/v1. Each router is either public or wholly behind `authenticate`. */
export const apiRoutes = createRouter()
  .get('/capabilities', c => { c.header('Cache-Control', 'no-store'); return c.json({ data: { documents: 1, organizationSettings: 2, documentStorageReady: documentStorageReady(), revision: process.env.SOURCE_COMMIT ?? 'development' } }); })
  .route('/documents', staffDocumentRoutes)
  .route('/auth', authRoutes)
  .route('/public', publicRoutes)
  .route('/me', meRoutes)
  .route('/org', orgRoutes)
  .route('/branches', branchRoutes)
  .route('/users', userRoutes)
  .route('/customers', customerRoutes)
  .route('/customer-app', customerAppRoutes)
  .route('/devices', deviceRoutes)
  .route('/dashboard', dashboardRoutes)
  .route('/plans', planRoutes)
  .route('/contracts', contractRoutes)
  .route('/payments', paymentRoutes)
  .route('/commands', commandRoutes)
  .route('/locks', lockRoutes)
  .route('/device', deviceApiRoutes)
  .route('/internal', internalRoutes);
