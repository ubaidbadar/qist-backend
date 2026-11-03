import { createFactory } from 'hono/factory';
import type { AppEnv, AuthEnv, DeviceEnv } from './hono';

/**
 * Controller actions are built with these, so an action can include its own validation and still get typed
 * input in the handler (Hono's recommended way to keep controllers separate from routes).
 */
export const publicController = createFactory<AppEnv>();
export const authedController = createFactory<AuthEnv>();
export const deviceController = createFactory<DeviceEnv>();
