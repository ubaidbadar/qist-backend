import * as health from '../controllers/health_controller';
import { createRouter } from '../lib/hono';

export const healthRoutes = createRouter().get('/', ...health.show);
