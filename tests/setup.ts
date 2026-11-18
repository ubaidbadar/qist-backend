import { afterAll } from 'bun:test';

/*
 * Preloaded before every test file (bunfig.toml). Tests always get their own database,
 * `<MONGODB_DB>_test_<run id>`, dropped at the end, so the dev and prod databases are never touched.
 * Without MONGODB_URI (no Atlas credentials yet) the integration suites are reported as skipped.
 */
const TEST_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const runId = `${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;

export const hasDatabase = Boolean(process.env.MONGODB_URI);
export const testDbName = `${process.env.MONGODB_DB ?? 'shop'}`.slice(0, 16) + `_test_${runId}`;

Object.assign(process.env, {
  NODE_ENV: 'test', // even if server/.env says development: emails go to the in-memory outbox
  // The client selects the database from the URI. Keep tests isolated even when a URI names production.
  MONGODB_URI: (process.env.MONGODB_URI ?? 'mongodb://database.invalid:27017').replace(
    /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?/, `$1/${testDbName}`,
  ),
  MONGODB_DB: testDbName,
  JWT_ACCESS_SECRET: `access-${TEST_SECRET}`,
  JWT_REFRESH_SECRET: `refresh-${TEST_SECRET}`,
  INTERNAL_JOB_SECRET: `job-${TEST_SECRET}`,
  APP_ORIGIN: 'http://localhost:3000',
  LOG_LEVEL: 'error',
  TRUST_PROXY: 'false',
  DEVICE_APP_APK_URL: 'https://downloads.example.invalid/qist-device.apk',
  DEVICE_APP_SIGNATURE_CHECKSUM: 'A'.repeat(43),
});

afterAll(async () => {
  const { default: mongoose } = await import('mongoose');
  const { closeDb } = await import('../src/db/client');
  const { connection } = mongoose;
  if (connection.readyState === mongoose.ConnectionStates.connected && connection.name.includes('_test_')) {
    const { recoveryDb, recoveryDbName } = await import('../src/models/device_recovery');
    if (recoveryDbName === `${connection.name}_recovery` && recoveryDbName.includes('_test_')) {
      await recoveryDb.dropDatabase();
    }
    await connection.dropDatabase();
  }
  await closeDb();
});
