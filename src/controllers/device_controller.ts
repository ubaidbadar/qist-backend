import { createHash, randomBytes } from 'node:crypto';
import { notifyCustomerDeviceChange } from '../lib/customer_notifications';
import {
  commandAckSchema,
  deviceCustomerAuthIssueSchema,
  deviceCheckinSchema,
  deviceEnrollSchema,
  DEVICE_CHECKIN_SECONDS,
  type DeviceCheckin,
  type DeviceCredential,
  type PendingCommand,
} from '@shop/shared';
import { withTransaction } from '../db/transaction';
import { env } from '../config/env';
import { acrossTenants } from '../db/tenant_guard';
import { recordSystemAudit } from '../lib/audit';
import { deviceController, publicController } from '../lib/factory';
import { parseId } from '../lib/ids';
import { lockScreenFor } from '../lib/lock_screen';
import { ConflictError, NotFoundError, UnauthorizedError } from '../lib/errors';
import { createTokenFor, readSecretToken, secretMatches } from '../lib/tokens';
import { validate } from '../lib/validate';
import { Device } from '../models/device';
import { Contract } from '../models/contract';
import { CustomerAuthHandoff } from '../models/customer_auth_handoff';
import { DeviceCommand } from '../models/device_command';

/** Commands the phone still has to carry out, and that a check-in should deliver. */
const DELIVERABLE = ['pending', 'delivered'] as const;

/**
 * POST /device/enroll — the device app redeems the one-time QR token for its long-lived credential. Not behind
 * device auth: the enrolment token itself is the proof. Replaces any earlier enrolment on the same phone.
 */
export const enroll = publicController.createHandlers(validate('json', deviceEnrollSchema), async (c) => {
  const { token, pushToken = '', appVersion = '', platform } = c.req.valid('json');
  const parsed = readSecretToken(token);
  if (!parsed) throw new UnauthorizedError('Invalid enrolment token');

  // The token names the phone; the organization is read from the phone itself.
  const device = await acrossTenants(Device.findById(parsed._id).select('orgId branchId enrollToken.secretHash enrollToken.expiresAt')).lean();
  const enrollToken = device?.enrollToken;
  if (!device || !enrollToken || !secretMatches(parsed.secret, enrollToken.secretHash)) {
    throw new UnauthorizedError('Invalid enrolment token');
  }
  if (enrollToken.expiresAt.getTime() < Date.now()) throw new UnauthorizedError('This enrolment QR has expired');

  const credential = createTokenFor(device._id);
  await withTransaction(async () => {
    await Device.updateOne(
      { _id: device._id, orgId: device.orgId },
      {
        $set: {
          enrollment: { secretHash: credential.secretHash, enrolledAt: new Date(), lastCheckInAt: null, pushToken, appVersion, platform },
        },
        $unset: { enrollToken: 1 },
      },
    );
    await recordSystemAudit(device.orgId, { action: 'device.enrolled', entity: 'device', entityId: device._id, branchId: device.branchId, summary: 'Phone enrolled the management app' });
  });

  return c.json({ data: { deviceId: String(device._id), token: credential.token, checkInSeconds: DEVICE_CHECKIN_SECONDS } satisfies DeviceCredential }, 201);
});

/** POST /device/checkin — the phone reports in, collects pending commands (marked delivered) and the lock screen. */
export const checkin = deviceController.createHandlers(validate('json', deviceCheckinSchema), async (c) => {
  const { device } = c.var;
  const { pushToken, appVersion, customerApp } = c.req.valid('json');

  const set: Record<string, unknown> = { 'enrollment.lastCheckInAt': new Date() };
  if (pushToken !== undefined) set['enrollment.pushToken'] = pushToken;
  if (appVersion !== undefined) set['enrollment.appVersion'] = appVersion;
  if (customerApp !== undefined) set['enrollment.customerApp'] = { ...customerApp, reportedAt: new Date() };

  const payload = await withTransaction(async () => {
    // Return the updated lock state with the check-in write; no second device read.
    const current = await Device.findOneAndUpdate(
      { _id: device._id, orgId: device.orgId },
      { $set: set },
      { returnDocument: 'after' },
    ).select('lockState').lean();
    await DeviceCommand.updateMany(
      { orgId: device.orgId, deviceId: device._id, status: 'pending' },
      { $set: { status: 'delivered' } },
    );
    const open = await DeviceCommand.find({ orgId: device.orgId, deviceId: device._id, status: { $in: [...DELIVERABLE] } })
      .select('type')
      .sort({ _id: 1 })
      .lean();
    const commands: PendingCommand[] = open.map((cmd) => ({ _id: String(cmd._id), type: cmd.type }));
    const lockScreen = await lockScreenFor({ orgId: device.orgId, deviceId: device._id, lockState: current?.lockState ?? 'unlocked' });
    return { lockState: current?.lockState ?? 'unlocked', lockScreen, commands, checkInSeconds: DEVICE_CHECKIN_SECONDS, customerAppRelease: env.CUSTOMER_APP_RELEASE_JSON ?? null } satisfies DeviceCheckin;
  });

  return c.json({ data: payload });
});

/** A same-device customer login ticket expires quickly and can be exchanged only once. */
const CUSTOMER_AUTH_HANDOFF_TTL_MS = 60_000;
const digestCustomerAuthValue = (value: string) => createHash('sha256').update(value).digest('hex');

/** The enrolled locker requests a one-use ticket; its long-lived credential never crosses IPC. */
export const issueCustomerAuthHandoff = deviceController.createHandlers(validate('json', deviceCustomerAuthIssueSchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { device } = c.var;
  const { nonce } = c.req.valid('json');

  const [owner] = await Contract.aggregate<{ phone: string }>([
    { $match: { orgId: device.orgId, deviceId: device._id, status: { $in: ['active', 'defaulted', 'completed'] } } },
    { $sort: { _id: -1 } },
    { $limit: 1 },
    {
      $lookup: {
        from: 'customers',
        let: { customerId: '$customerId', orgId: '$orgId' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$_id', '$$customerId'] }, { $eq: ['$orgId', '$$orgId'] }] } } },
          { $project: { phone: 1 } },
        ],
        as: 'customer',
      },
    },
    {
      $lookup: {
        from: 'orgs',
        localField: 'orgId',
        foreignField: '_id',
        pipeline: [{ $match: { status: 'active' } }, { $project: { _id: 1 } }],
        as: 'org',
      },
    },
    { $match: { 'customer.0': { $exists: true }, 'org.0': { $exists: true } } },
    { $project: { _id: 0, phone: { $arrayElemAt: ['$customer.phone', 0] } } },
  ]);

  if (!owner?.phone) throw new UnauthorizedError('This enrolled phone is not eligible for customer sign-in');

  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CUSTOMER_AUTH_HANDOFF_TTL_MS);
  await CustomerAuthHandoff.create({
    ticketHash: digestCustomerAuthValue(ticket),
    nonceHash: digestCustomerAuthValue(nonce),
    phone: owner.phone,
    orgId: device.orgId,
    deviceId: device._id,
    expiresAt,
  });

  return c.json({ data: { ticket, expiresAt: expiresAt.toISOString() } });
});

/** The lock state a carried-out command leaves the phone in. */
const RESULT_LOCK_STATE = { lock: 'locked', unlock: 'unlocked', release: 'unlocked' } as const;

/** POST /device/commands/:id/ack — the phone reports whether it carried out a delivered command. */
export const acknowledge = deviceController.createHandlers(validate('json', commandAckSchema), async (c) => {
  const { device } = c.var;
  const { result, detail = '' } = c.req.valid('json');
  const commandId = parseId(c.req.param('id'), 'Command');

  const updated = await withTransaction(async () => {
    // A successful acknowledgement takes one atomic read/write, not a read, write and reread.
    const command = await DeviceCommand.findOneAndUpdate(
      { _id: commandId, orgId: device.orgId, deviceId: device._id, status: { $in: [...DELIVERABLE] } },
      { $set: result === 'failed' ? { status: 'failed', decisionReason: detail } : { status: 'acknowledged' } },
      { returnDocument: 'after' },
    ).lean();

    if (!command) {
      // Keep 404 vs 409 responses on the uncommon invalid/stale acknowledgement path.
      const existing = await DeviceCommand.exists({ _id: commandId, orgId: device.orgId, deviceId: device._id });
      if (!existing) throw new NotFoundError('Command');
      throw new ConflictError('This command is no longer waiting');
    }

    if (result === 'failed') {
      await recordSystemAudit(device.orgId, {
        action: 'device.command_failed',
        entity: 'device',
        entityId: device._id,
        branchId: device.branchId,
        summary: `Phone could not ${command.type} ${command.deviceLabel}${detail ? `: ${detail}` : ''}`,
      });
      return command;
    }

    const deviceSet: Record<string, unknown> = { lockState: RESULT_LOCK_STATE[command.type] };
    if (command.type === 'release') deviceSet.stockStatus = 'released';
    await Device.updateOne({ _id: device._id, orgId: device.orgId }, { $set: deviceSet });
    await recordSystemAudit(device.orgId, {
      action: `device.${command.type}ed`,
      entity: 'device',
      entityId: device._id,
      branchId: device.branchId,
      summary: `Phone confirmed ${command.type} of ${command.deviceLabel}`,
    });
    return command;
  });

  if (result !== 'failed') await notifyCustomerDeviceChange(device.orgId, device._id, updated._id);
  return c.json({ data: updated });
});
