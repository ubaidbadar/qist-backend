import mongoose from 'mongoose';
import '../src/app'; // importing the app registers every model
import { env } from '../src/config/env';
import { closeDb, connectDb } from '../src/db/client';
import { ensureIndexes } from '../src/db/indexes';
import { logger } from '../src/lib/logger';

await connectDb();
await ensureIndexes();
logger.info('Indexes are up to date', { db: env.MONGODB_DB, models: mongoose.modelNames() });
await closeDb();
