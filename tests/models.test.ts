import { beforeAll, describe, expect, test } from 'bun:test';
import { Types } from 'mongoose';
import { acrossTenants } from '../src/db/tenant_guard';
import { AuditLog } from '../src/models/audit_log';
import { Contract } from '../src/models/contract';
import { Counter } from '../src/models/counter';
import { DeviceCommand } from '../src/models/device_command';
import { Payment } from '../src/models/payment';
import { Customer } from '../src/models/customer';
import { Installment } from '../src/models/installment';
import { InstallmentPlan } from '../src/models/installment_plan';
import { Device } from '../src/models/device';
import { EmailToken } from '../src/models/email_token';
import { RefreshToken } from '../src/models/refresh_token';
import { Branch } from '../src/models/branch';
import { User } from '../src/models/user';
import { prepareDatabase, signupOrg } from './api';
import { hasDatabase } from './setup';

describe.skipIf(!hasDatabase)('model rules', () => {
  beforeAll(prepareDatabase);

  test('a query on organization data without orgId is refused', async () => {
    const someId = new Types.ObjectId();
    await expect(Branch.findById(someId).exec()).rejects.toThrow('Branch query without an orgId filter');
    await expect(Branch.updateOne({ _id: someId }, { $set: { name: 'x' } }).exec()).rejects.toThrow('without an orgId filter');
    await expect(User.countDocuments({ role: 'owner' }).exec()).rejects.toThrow('without an orgId filter');
    await expect(Branch.aggregate([{ $match: { active: true } }]).exec()).rejects.toThrow('must start with { $match: { orgId } }');
  });

  test('scoped queries, and the marked sign-in lookups, are allowed', async () => {
    const { session, email } = await signupOrg();
    const orgId = new Types.ObjectId(session.org._id);
    expect(await Branch.countDocuments({ orgId })).toBe(1);
    expect(await Branch.aggregate([{ $match: { orgId } }, { $count: 'n' }]).exec()).toEqual([{ n: 1 }]);
    expect(await acrossTenants(User.findOne({ email })).lean()).toMatchObject({ email });
  });

  test('audit log entries cannot be changed or deleted', async () => {
    const { session } = await signupOrg();
    const orgId = new Types.ObjectId(session.org._id);
    expect(await AuditLog.countDocuments({ orgId })).toBe(1);
    await expect(AuditLog.updateOne({ orgId }, { $set: { summary: 'rewritten' } }).exec()).rejects.toThrow('cannot be changed or deleted');
    await expect(AuditLog.deleteMany({ orgId }).exec()).rejects.toThrow('cannot be changed or deleted');
    expect(await AuditLog.countDocuments({ orgId })).toBe(1);
  });

  test('only the indexes queries need exist; everything else uses the automatic _id index', async () => {
    const indexNames = async (model: { listIndexes: () => Promise<{ name?: string }[]> }) =>
      (await model.listIndexes()).map((index) => index.name).sort();

    expect(await indexNames(Branch)).toEqual(['_id_', 'orgId_1']);
    expect(await indexNames(User)).toEqual(['_id_', 'email_1', 'orgId_1']);
    expect(await indexNames(RefreshToken)).toEqual(['_id_', 'expiresAt_1', 'userId_1']);
    expect(await indexNames(EmailToken)).toEqual(['_id_', 'expiresAt_1']);
    expect(await indexNames(AuditLog)).toEqual(['_id_']);
    expect(await indexNames(Customer)).toEqual(['_id_', 'orgId_1__id_-1', 'orgId_1_cnic_1']);
    expect(await indexNames(Payment)).toEqual(['_id_', 'orgId_1_contractId_1', 'orgId_1_idempotencyKey_1', 'orgId_1_receivedOn_1_branchId_1']);
    expect(await indexNames(Counter)).toEqual(['_id_', 'orgId_1_branchId_1_name_1']);
    expect(await indexNames(Contract)).toEqual(['_id_', 'orgId_1__id_-1', 'orgId_1_branchId_1__id_-1', 'orgId_1_customerId_1', 'orgId_1_deviceId_1_status_1__id_-1']);
    expect(await indexNames(Installment)).toEqual(['_id_', 'orgId_1_branchId_1_status_1_dueDate_1', 'orgId_1_contractId_1_number_1', 'orgId_1_status_1_dueDate_1']);
    expect(await indexNames(DeviceCommand)).toEqual(['_id_', 'orgId_1_contractId_1__id_-1', 'orgId_1_deviceId_1', 'orgId_1_deviceId_1_status_1__id_1', 'orgId_1_status_1__id_-1']);
    expect(await indexNames(InstallmentPlan)).toEqual(['_id_', 'orgId_1']);
    expect(await indexNames(Device)).toEqual(['_id_', 'orgId_1__id_-1', 'orgId_1_branchId_1__id_-1', 'orgId_1_imeis_1']);

    // `expires: 0` on expiresAt: MongoDB deletes expired tokens by itself.
    const ttl = (await RefreshToken.listIndexes()).find((index) => index.name === 'expiresAt_1');
    expect(ttl?.expireAfterSeconds).toBe(0);
  });
});
