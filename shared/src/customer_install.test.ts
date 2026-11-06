import { describe, expect, test } from 'bun:test';
import { customerAppReleaseSchema } from './customer_install';
import { deviceCheckinSchema } from './device_api';

import { VALID_RELEASE } from '../../tests/customer_install_fixture';

describe('deferred customer installation contract', () => {
  test('requires a pinned customer APK and defaults to unmetered downloads', () => {
    expect(customerAppReleaseSchema.parse(VALID_RELEASE).wifiOnly).toBe(true);
    expect(customerAppReleaseSchema.parse({ ...VALID_RELEASE, wifiOnly: false }).wifiOnly).toBe(false);
    for (const changes of [{ packageName: 'another.app' }, { apkUrl: 'http://example.com/app.apk' }, { apkUrl: 'https://user:pass@example.com/a.apk' }, { sha256: 'bad' }, { versionCode: 0 }, { sizeBytes: 201 * 1024 * 1024 }]) {
      expect(customerAppReleaseSchema.safeParse({ ...VALID_RELEASE, ...changes }).success).toBe(false);
    }
  });
  test('keeps older check-ins compatible and only accepts bounded known statuses', () => {
    expect(deviceCheckinSchema.parse({})).toEqual({});
    expect(deviceCheckinSchema.parse({ customerApp: { status: 'installed', versionCode: 3 } }).customerApp?.versionCode).toBe(3);
    expect(deviceCheckinSchema.safeParse({ customerApp: { status: 'invented' } }).success).toBe(false);
    expect(deviceCheckinSchema.safeParse({ customerApp: { status: 'failed', detailCode: 'raw secret error' } }).success).toBe(false);
  });
});
