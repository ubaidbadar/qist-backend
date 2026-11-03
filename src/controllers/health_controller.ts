import { pingDb } from '../db/client';
import { publicController } from '../lib/factory';

/** GET /health: liveness plus database reachability, for the Docker healthcheck and uptime monitors. */
export const show = publicController.createHandlers(async (c) => {
  const dbUp = await pingDb();
  return c.json({ data: { status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down' } }, dbUp ? 200 : 503);
});
