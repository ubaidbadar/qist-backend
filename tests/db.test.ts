import { beforeAll, describe, expect, test } from 'bun:test';
import mongoose, { Schema } from 'mongoose';
import { connectDb } from '../src/db/client';
import { ensureIndexes } from '../src/db/indexes';
import { withTransaction } from '../src/db/transaction';
import { hasDatabase } from './setup';

const Probe = mongoose.model(
  'TxProbe',
  new Schema({ value: { type: Number, required: true } }).index({ value: 1 }, { unique: true }),
  'txProbe',
);

describe.skipIf(!hasDatabase)('database (Atlas integration)', () => {
  beforeAll(async () => {
    await connectDb();
    await ensureIndexes();
  });

  test('runs against a throwaway test database', () => {
    expect(mongoose.connection.name).toContain('_test_');
  });

  test('ensureIndexes creates collections and declared indexes, and is safe to run twice', async () => {
    await ensureIndexes();
    const indexes = await Probe.listIndexes();
    expect(indexes.map((index) => index.name)).toContain('value_1');
  });

  test('withTransaction commits on success and rolls back on error, without passing the session', async () => {
    await withTransaction(async () => {
      await Probe.create({ value: 1 });
    });

    const failing = withTransaction(async () => {
      await Probe.create({ value: 2 });
      throw new Error('abort');
    });

    await expect(failing).rejects.toThrow('abort');
    expect(await Probe.countDocuments()).toBe(1);
  });

  test('strict mode rejects fields the schema does not define', async () => {
    // TypeScript rejects this as a literal; the test covers data that reaches the model without validation.
    const unvalidated: { value: number } = Object.assign({ value: 3 }, { extra: true });
    await expect(Probe.create(unvalidated)).rejects.toThrow('extra');
  });
});
