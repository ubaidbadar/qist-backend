import { DEVICE_ADMIN_COMPONENT, ENROLL_TOKEN_EXTRA, SHOP_TIME_ZONE, type ProvisioningPayload } from '@shop/shared';
import { env } from '../config/env';
import { ConflictError } from './errors';

/** Where the device app is downloaded from and how to recognise it, or an error naming what is not configured. */
function deviceApp() {
  const { DEVICE_APP_APK_URL: apkUrl, DEVICE_APP_SIGNATURE_CHECKSUM: signatureChecksum } = env;
  if (!apkUrl || !signatureChecksum) {
    throw new ConflictError('Phone enrolment is not set up on this server yet (device app download link missing)');
  }
  return { apkUrl, signatureChecksum };
}

/** Throws unless this server can build a provisioning QR; call it before issuing a token. */
export const assertProvisioningConfigured = () => void deviceApp();

/**
 * The Android provisioning QR for a factory-fresh phone: download our app, check its signature, make it Device
 * Owner, and pass it the one-time enrolment token.
 */
export function provisioningPayload(enrollToken: string): ProvisioningPayload {
  const { apkUrl, signatureChecksum } = deviceApp();
  return {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': DEVICE_ADMIN_COMPONENT,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': apkUrl,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': signatureChecksum,
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
    'android.app.extra.PROVISIONING_SKIP_EDUCATION_SCREENS': true,
    'android.app.extra.PROVISIONING_TIME_ZONE': SHOP_TIME_ZONE,
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { [ENROLL_TOKEN_EXTRA]: enrollToken },
  };
}
