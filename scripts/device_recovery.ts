import { createInterface } from 'node:readline/promises';
import { Types } from 'mongoose';
import { connectDb, closeDb } from '../src/db/client';
import { acrossTenants } from '../src/db/tenant_guard';
import { authorizeOrphanRelease } from '../src/lib/device_recovery';
import { wakeDeviceToken } from '../src/lib/push';
import { Device } from '../src/models/device';
import { DeviceRecovery } from '../src/models/device_recovery';

const action = process.argv[2];
const id = process.argv[3];
const ID = /^[a-fA-F0-9]{24}$/;

async function list() {
  const rows = await acrossTenants(
    DeviceRecovery.find({}).select('orgId branchId status lastCheckInAt commandId').sort({ _id: 1 }),
  ).lean();
  if (!rows.length) {
    console.log('No survival records. Deleted device enrollment credentials cannot be reconstructed.');
    return;
  }
  for (const row of rows) {
    console.log(JSON.stringify({
      deviceId: String(row._id),
      orgId: String(row.orgId),
      status: row.status,
      lastCheckInAt: row.lastCheckInAt?.toISOString() ?? null,
    }));
  }
}

async function backfill() {
  let copied = 0;
  const query = acrossTenants(
    Device.find({ 'enrollment.secretHash': { $exists: true } })
      .select('orgId branchId enrollment.secretHash enrollment.pushToken enrollment.lastCheckInAt'),
  );
  for await (const device of query.cursor()) {
    if (!device.enrollment?.secretHash) continue;
    // Never reactivate a deliberately revoked/released survival record.
    await DeviceRecovery.updateOne(
      { _id: device._id, orgId: device.orgId },
      {
        $setOnInsert: {
          branchId: device.branchId,
          secretHash: device.enrollment.secretHash,
          pushToken: device.enrollment.pushToken ?? '',
          status: 'active',
          commandId: null,
          lastCheckInAt: device.enrollment.lastCheckInAt ?? null,
        },
      },
      { upsert: true },
    );
    copied += 1;
  }
  console.log(`Synced ${copied} enrolled phone(s). No device or contract data changed.`);
}

async function requestRelease(deviceId: Types.ObjectId) {
  const enrolled = await acrossTenants(DeviceRecovery.findById(deviceId).select('+pushToken')).lean();
  if (!enrolled) {
    throw new Error('No survival verifier exists. A database-only recovery is impossible for this device.');
  }
  if (enrolled.status !== 'active') throw new Error(`Recovery is not available in status ${enrolled.status}`);

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('This irrevocably authorizes the existing Qist Locker to release Android Device Owner.');
    console.log('Only continue after verifying the physical phone and your authorization to release it.');
    console.log(`Device ID: ${deviceId}`);
    console.log(`Last successful contact: ${enrolled.lastCheckInAt?.toISOString() ?? 'unknown'}`);
    const expected = `RELEASE ${deviceId}`;
    const confirmed = await prompt.question(`Type "${expected}" to confirm: `);
    if (confirmed !== expected) throw new Error('Confirmation failed; no recovery authorized.');
  } finally {
    prompt.close();
  }

  const saved = await authorizeOrphanRelease(deviceId);
  if (!saved) throw new Error('Recovery was not authorized: device already released, revoked or not found.');
  console.log(`Release authorized for device ${deviceId}; command ${saved.commandId}`);
  console.log('This did not modify or recreate any installment/contract/retailer data.');
  console.log(saved.pushToken
    ? (await wakeDeviceToken(saved.pushToken, String(deviceId))
      ? 'FCM wake-up accepted. Actual execution still requires phone connectivity and a check-in.'
      : 'FCM wake-up was unavailable; the phone can still receive the release on its next check-in.')
    : 'No FCM token was retained. The phone must check in by itself.');
}

async function main() {
  if (!['list', 'backfill', 'release'].includes(action ?? '')) {
    throw new Error('Usage: bun scripts/device_recovery.ts [list | backfill | release <24-hex-device-id>]');
  }
  if (action === 'release' && (!id || !ID.test(id))) {
    throw new Error('Supply the exact 24-character MongoDB device ID to release.');
  }
  if (action === 'release' && !process.stdin.isTTY) {
    throw new Error('Release requires an interactive SSH terminal; noninteractive automation is forbidden.');
  }
  await connectDb();
  await DeviceRecovery.db.createCollections();
  await DeviceRecovery.createIndexes();
  try {
    if (action === 'list') await list();
    else if (action === 'backfill') await backfill();
    else if (id && ID.test(id)) await requestRelease(new Types.ObjectId(id));
    else throw new Error('Missing or invalid device ID');
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Recovery command failed');
  process.exitCode = 1;
});
