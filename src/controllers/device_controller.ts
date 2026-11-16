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
import { AppError, ConflictError, NotFoundError, UnauthorizedError } from '../lib/errors';
import { createTokenFor, readSecretToken, secretMatches } from '../lib/tokens';
import { validate } from '../lib/validate';
import { Device } from '../models/device';
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

/** Deprecated bearer-only handoffs cannot meet the device-bound proof requirement. */
export const issueCustomerAuthHandoff = deviceController.createHandlers(validate('json', deviceCustomerAuthIssueSchema), () => {
  throw new AppError('DEVICE_AUTH_UNAVAILABLE', 503, 'Update Qist Locker to use secure device sign-in, or use password or WhatsApp recovery.');
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
