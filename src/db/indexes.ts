import mongoose from 'mongoose';
import { DeviceRecovery, recoveryDb } from '../models/device_recovery';

/**
 * Creates the collections and indexes of every registered model. Indexes are declared on each model's
 * schema (`schema.index(...)`, next to the fields they cover) and every tenant index starts with `orgId`.
 * Creating collections up front matters: a transaction cannot create one with snapshot read concern.
 * This only adds what is missing and never drops an index.
 */
export async function ensureIndexes() {
  await mongoose.connection.createCollections();
  for (const model of Object.values(mongoose.models)) {
    await model.createIndexes();
  }
  // Keep the recovery collection outside the qist database before enrollment transactions begin.
  await recoveryDb.createCollections();
  await DeviceRecovery.createIndexes();
}
