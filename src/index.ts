import { createApp } from './app';
import { env } from './config/env';
import { closeDb, connectDb } from './db/client';
import { ensureIndexes } from './db/indexes';
import { scheduleJobs } from './jobs/schedule';
import { logger } from './lib/logger';

// Importing the app has registered every model, so their collections and indexes can be created.
await connectDb();
await ensureIndexes();

const server = Bun.serve({ port: env.PORT, fetch: createApp().fetch, maxRequestBodySize: 10 * 1024 * 1024 });
logger.info('API listening', { port: server.port, env: env.NODE_ENV });
scheduleJobs();

async function shutdown(signal: string) {
  logger.info('Shutting down', { signal });
  await server.stop();
  await closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
