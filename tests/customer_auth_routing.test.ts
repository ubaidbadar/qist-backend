import { expect, spyOn, test } from 'bun:test';
import { Customer } from '../src/models/customer';
import { call } from './api';

test('first-password routing requires Locker verification and emits no external message', async () => {
  const plans = spyOn(Customer, 'aggregate').mockResolvedValue([{ hasPassword: false }]);
  const fetch = spyOn(globalThis, 'fetch');
  try {
    const result = await call('POST', '/customer-app/auth/start', { body: { phone: '03001234567' } });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ next: 'device' });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    plans.mockRestore();
    fetch.mockRestore();
  }
});
for (const path of ['request-code', 'verify-code', 'forgot-password', 'reset-password'])
  test(`removed ${path} cannot send a message or issue a session`, async () => {
    const fetch = spyOn(globalThis, 'fetch');
    try {
      const result = await call('POST', `/customer-app/auth/${path}`, {
        body: { phone: '03001234567', code: '123456' },
      });
      expect(result.status).toBe(410);
      expect(result.data).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
