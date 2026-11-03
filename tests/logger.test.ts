import { expect, test } from 'bun:test';
import { redact } from '../src/lib/logger';

test('redacts personal data and credentials at any depth', () => {
  const input = {
    path: '/customers',
    customer: { fullName: 'Ayesha Khan', cnic: '35202-1234567-1', phone: '03001234567' },
    guarantors: [{ guarantorPhone: '03111234567' }],
    headers: { Authorization: 'Bearer x', cookie: 'refresh=y' },
  };

  expect(redact(input)).toEqual({
    path: '/customers',
    customer: { fullName: 'Ayesha Khan', cnic: '[redacted]', phone: '[redacted]' },
    guarantors: [{ guarantorPhone: '[redacted]' }],
    headers: { Authorization: '[redacted]', cookie: '[redacted]' },
  });
});
