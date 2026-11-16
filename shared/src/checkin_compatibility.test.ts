import { describe, expect, test } from 'bun:test';
import { deviceCheckinSchema } from './device_api';

describe('installed locker check-in compatibility', () => {
  test('accepts the default report emitted by Kotlin serialization', () => {
    const wire = { appVersion: '0.2.0', lockState: 'unlocked', customerApp: {} };
    expect(deviceCheckinSchema.parse(wire).customerApp?.status).toBe('pending');
  });
  test('keeps supporting older APKs and rejects invented statuses', () => {
    expect(deviceCheckinSchema.safeParse({ lockState: 'unlocked' }).success).toBe(true);
    expect(deviceCheckinSchema.safeParse({ customerApp: { status: 'invented' } }).success).toBe(false);
  });
});
