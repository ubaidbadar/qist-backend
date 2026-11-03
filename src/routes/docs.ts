import * as docs from '../controllers/docs_controller';
import { createRouter } from '../lib/hono';

export const docsRoutes = createRouter().get('/', ...docs.show);
