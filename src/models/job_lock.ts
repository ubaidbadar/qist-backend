import { model, Schema } from 'mongoose';

/** A lease per job, keyed by the job's name, so two API instances never run the same job at once. */
const jobLockSchema = new Schema(
  {
    _id: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
  },
  { collection: 'jobLocks', versionKey: false },
);

export const JobLock = model('JobLock', jobLockSchema);
