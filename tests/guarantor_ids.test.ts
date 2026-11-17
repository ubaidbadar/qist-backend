import { expect, test } from 'bun:test';
import { preserveGuarantorIds } from '../src/lib/guarantor_ids';
const id = 'fbe414f0-2a6b-4ee9-90c5-7f1d7188860f';
const person = {
  id,
  fullName: 'Fixture Person',
  cnic: '1234512345671',
  phone: '03001234567',
  relation: 'brother',
};
test('reordering and legacy clients preserve stable guarantor identity', () => {
  const { id: _id, ...withoutId } = person;
  expect(preserveGuarantorIds([person], [{ ...withoutId, fullName: 'Corrected Name' }])[0].id).toBe(id);
  expect(preserveGuarantorIds([], [withoutId])[0].id).toMatch(/^[a-f0-9-]{36}$/);
});
test('an identity correction never moves existing guarantor scans to a different CNIC', () => {
  expect(() => preserveGuarantorIds([person], [{ ...person, cnic: '1234512345672' }])).toThrow(
    'identity changed',
  );
  expect(() => preserveGuarantorIds([person], [person, person])).toThrow('once');
  expect(() => preserveGuarantorIds([], [person])).toThrow('identity changed');
});
