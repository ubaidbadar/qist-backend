import type { Types } from 'mongoose';
import { Device } from '../models/device';
import { logger } from './logger';

/**
 * Nudges a phone to check in now, so a lock or unlock reaches it in seconds instead of at its next poll. Until the
 * FCM credentials are set this logs and returns; the phone still picks the command up on its regular check-in, so
 * nothing is lost. Best-effort: call it after the command is committed, never inside the transaction.
 */
export async function wakeDevice(orgId: Types.ObjectId, deviceId: Types.ObjectId): Promise<void> {
  try {
    const device = await Device.findOne({ _id: deviceId, orgId }).select('enrollment.pushToken').lean();
    const pushToken = device?.enrollment?.pushToken;
    if (!pushToken) return; // not enrolled, or no push token yet: the next check-in will collect the command
    // TODO(P2): send an FCM data message to `pushToken`. No-op until FCM credentials are configured.
    logger.debug('wakeDevice: would push (FCM not configured)', { deviceId: String(deviceId) });
  } catch (err) {
    logger.warn('wakeDevice failed', { err: String(err), deviceId: String(deviceId) });
  }
}
