import mongoose, { type ClientSession, type mongo } from 'mongoose';

const TRANSACTION_OPTIONS: mongo.TransactionOptions = {
  readPreference: 'primary',
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
};

/**
 * Runs `work` in a transaction and returns its result. Every Mongoose query inside it joins the transaction
 * on its own (transactionAsyncLocalStorage), so repositories don't pass the session around. The driver retries
 * the whole callback on transient errors and the commit on UnknownTransactionCommitResult, so `work` must be
 * safe to re-run: no side effects outside the database.
 */
export const withTransaction = <T>(work: (session: ClientSession) => Promise<T>): Promise<T> =>
  mongoose.connection.transaction(work, TRANSACTION_OPTIONS);
