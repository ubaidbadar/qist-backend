import { expect, spyOn, test } from 'bun:test';
import { Query } from 'mongoose';
import { Customer } from '../src/models/customer';
import { whatsappTestOutbox } from '../src/lib/whatsapp';
import * as push from '../src/lib/push';
import { call } from './api';

// Exercise the real router/validation/controller without pretending to test MongoDB atomicity.
test('phone-first endpoint returns retailer guidance without looking up a password when no plan exists', async () => {
  const plans = spyOn(Customer, 'aggregate').mockResolvedValue([]);
  const reads = spyOn(Query.prototype, 'exec');
  try {
    const result = await call('POST', '/customer-app/auth/start', { body: { phone: '+92 300 1234567' } });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ next: 'unregistered' });
    expect(reads).not.toHaveBeenCalled();
    expect(JSON.stringify(result.data)).not.toContain('passwordHash');
  } finally { plans.mockRestore(); reads.mockRestore(); }
});

test('existing-password routing never sends a WhatsApp code or returns financial records', async () => {
  const plans = spyOn(Customer, 'aggregate').mockResolvedValue([{ _id: 'test-only' }]);
  const reads = spyOn(Query.prototype, 'exec').mockResolvedValue({ passwordHash: 'private-test-hash' });
  const sent = whatsappTestOutbox.length;
  try {
    const result = await call('POST', '/customer-app/auth/start', { body: { phone: '03001234567' } });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ next: 'password' });
    expect(whatsappTestOutbox.length).toBe(sent);
    expect(JSON.stringify(result.data)).not.toContain('private-test-hash');
  } finally { plans.mockRestore(); reads.mockRestore(); }
});

test('first-password routing prefers the enrolled lock app and never returns the OTP', async () => {
  const plans = spyOn(Customer, 'aggregate')
    .mockResolvedValueOnce([{ _id: 'test-customer' }] as never)
    .mockResolvedValueOnce([{ token: 'enrolled-locker-fcm-token' }] as never);
  const queries = spyOn(Query.prototype, 'exec').mockResolvedValueOnce(null).mockResolvedValueOnce({});
  const send = spyOn(push, 'sendDeviceCustomerAuthCode').mockResolvedValue(true);
  const sent = whatsappTestOutbox.length;
  try {
    const result = await call('POST', '/customer-app/auth/start', { body: { phone: '03001234567' } });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ next: 'otp', retryAfterSeconds: 60, delivery: 'device' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('enrolled-locker-fcm-token');
    expect(whatsappTestOutbox.length).toBe(sent);
    expect(JSON.stringify(result.data)).not.toMatch(/[0-9]{6}/);
  } finally { plans.mockRestore(); queries.mockRestore(); send.mockRestore(); }
});

test('switching from locker delivery to WhatsApp revokes the old locker code', async () => {
  const plans = spyOn(Customer, 'aggregate')
    .mockResolvedValueOnce([{ _id: 'test-customer' }] as never)
    .mockResolvedValueOnce([{ token: 'enrolled-locker-fcm-token' }] as never);
  const queries = spyOn(Query.prototype, 'exec').mockResolvedValueOnce({ reset: { requestId: 'old-request-id' } });
  const cancel = spyOn(push, 'cancelDeviceCustomerAuthCode').mockResolvedValue(undefined);
  const sent = whatsappTestOutbox.length;
  try {
    const result = await call('POST', '/customer-app/auth/request-code', {
      body: { phone: '03001234567', channel: 'whatsapp' },
    });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ retryAfterSeconds: 60, delivery: 'whatsapp' });
    expect(cancel).toHaveBeenCalledWith('enrolled-locker-fcm-token', 'old-request-id');
    expect(whatsappTestOutbox.length).toBe(sent + 1);
  } finally { plans.mockRestore(); queries.mockRestore(); cancel.mockRestore(); }
});

test('first-password routing sends one code and returns the resend cooldown', async () => {
  const plans = spyOn(Customer, 'aggregate').mockResolvedValue([{ _id: 'test-only' }]);
  const queries = spyOn(Query.prototype, 'exec').mockResolvedValueOnce(null).mockResolvedValueOnce({});
  const sent = whatsappTestOutbox.length;
  try {
    const result = await call('POST', '/customer-app/auth/start', { body: { phone: '03001234567' } });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ next: 'otp', retryAfterSeconds: 60, delivery: 'whatsapp' });
    expect(whatsappTestOutbox.length).toBe(sent + 1);
    expect(JSON.stringify(result.data)).not.toContain(whatsappTestOutbox.at(-1)!.code);
  } finally { plans.mockRestore(); queries.mockRestore(); }
});
