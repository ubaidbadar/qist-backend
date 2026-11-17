import { closeDb, connectDb } from '../src/db/client';
import { Customer } from '../src/models/customer';
import { acrossTenants } from '../src/db/tenant_guard';
await connectDb();
let changed = 0;
for await (const customer of acrossTenants(Customer.find({ 'guarantors.0': { $exists: true } }))
  .lean()
  .cursor()) {
  if (customer.guarantors.every((g) => g.id)) continue;
  const guarantors = customer.guarantors.map((g) => ({ ...g, id: g.id ?? crypto.randomUUID() }));
  const result = await Customer.updateOne(
    { _id: customer._id, orgId: customer.orgId, updatedAt: customer.updatedAt },
    { $set: { guarantors } },
  );
  changed += result.modifiedCount;
}
console.log(`Assigned stable guarantor IDs to ${changed} records; no personal data logged.`);
await closeDb();
