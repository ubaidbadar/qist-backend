import { expect, test } from 'bun:test';
import { customerPushDisposition, pushRetryAfterSeconds } from '../src/lib/push';
const fcm = (errorCode: string) => ({ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode });
const body = (...details: unknown[]) => ({ error: { details } });

test('only confirmed invalid FCM registrations are removed', () => {
  expect(customerPushDisposition(404, body(fcm('UNREGISTERED')))).toBe('gone');
  expect(customerPushDisposition(400, body(fcm('INVALID_ARGUMENT')))).toBe('gone');
  expect(customerPushDisposition(403, body(fcm('SENDER_ID_MISMATCH')))).toBe('retry');
  expect(customerPushDisposition(401, {})).toBe('retry');
  expect(customerPushDisposition(503, body(fcm('UNREGISTERED')))).toBe('retry');
});
test('a bad payload must not delete an otherwise valid installation token', () => {
  const badRequest = { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.data' }] };
  expect(customerPushDisposition(400, body(badRequest))).toBe('retry');
  expect(customerPushDisposition(400, body(badRequest, fcm('INVALID_ARGUMENT')))).toBe('retry');
  expect(customerPushDisposition(503, null)).toBe('retry');
  expect(customerPushDisposition(429, { error: 'overloaded' })).toBe('retry');
  expect(customerPushDisposition(200, {})).toBe('sent');
});
test('provider Retry-After accepts seconds and HTTP dates and rejects invalid or past waits', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  expect(pushRetryAfterSeconds('3600', now)).toBe(3600);
  expect(pushRetryAfterSeconds('Sat, 07 Nov 2026 13:00:00 GMT', now)).toBe(3600);
  for (const value of [null, '-1', 'nonsense', 'NaN', '1.5', 'Sat, 07 Nov 2026 11:00:00 GMT']) expect(pushRetryAfterSeconds(value, now)).toBe(0);
  expect(pushRetryAfterSeconds('999999999999999999999999', now)).toBe(90 * 86400);
});
