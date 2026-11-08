import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';

const PING_TIMEOUT_MS = 2_000;
const { connected } = mongoose.ConnectionStates;

// Process-wide Mongoose behaviour, set before any model is compiled.
mongoose.set('strict', 'throw'); // saving a field the schema doesn't define is a bug, not something to drop silently
mongoose.set('strictQuery', 'throw'); // so is filtering on one: a dropped filter would widen the query
mongoose.set('autoIndex', false); // indexes are built by ensureIndexes(), not as a side effect of compiling a model
mongoose.set('transactionAsyncLocalStorage', true); // every query inside withTransaction() joins the transaction

export async function connectDb() {
  if (mongoose.connection.readyState === connected) return;
  await mongoose.connect(env.MONGODB_URI);
}

export const closeDb = () => mongoose.disconnect();

/** For the health check: true when the database answers within a short timeout. */
export async function pingDb(): Promise<boolean> {
  const { db, readyState } = mongoose.connection;
  if (readyState !== connected || !db) return false;

  // A hard deadline: a dropped network can otherwise hold the ping for the full server-selection timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${PING_TIMEOUT_MS} ms`)), PING_TIMEOUT_MS);
  });

  try {
    await Promise.race([db.admin().ping(), deadline]);
    return true;
  } catch (err) {
    logger.warn('Database ping failed', { err });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
