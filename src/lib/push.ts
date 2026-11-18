import { readFile } from 'node:fs/promises';
import { importPKCS8, SignJWT } from 'jose';
import type { Types } from 'mongoose';
import { Device } from '../models/device';
import { logger } from './logger';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface AccessToken {
  value: string;
  expiresAt: number;
}

let credentialsPromise: Promise<ServiceAccount> | undefined;
let accessTokenPromise: Promise<AccessToken> | undefined;

async function credentials(): Promise<ServiceAccount> {
  if (!credentialsPromise) {
    credentialsPromise = (async () => {
      const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (!path) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not configured');
      const account = JSON.parse(await readFile(path, 'utf8')) as ServiceAccount;
      if (!account.project_id || !account.client_email || !account.private_key) {
        throw new Error('Invalid Firebase service account');
      }
      return account;
    })().catch((error: unknown) => {
      credentialsPromise = undefined;
      throw error;
    });
  }
  return credentialsPromise;
}

async function accessToken(): Promise<string> {
  if (!accessTokenPromise) {
    accessTokenPromise = (async () => {
      const account = await credentials();
      const uri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
      const key = await importPKCS8(account.private_key, 'RS256');
      const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(account.client_email)
        .setAudience(uri)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key);
      const response = await fetch(uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Firebase OAuth token request failed: HTTP ${response.status}`);
      const data = await response.json() as { access_token?: string; expires_in?: number };
      if (!data.access_token) throw new Error('Firebase OAuth response omitted access_token');
      return { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    })().catch((error: unknown) => {
      accessTokenPromise = undefined;
      throw error;
    });
  }
  const token = await accessTokenPromise;
  if (Date.now() >= token.expiresAt - 60_000) {
    accessTokenPromise = undefined;
    return accessToken();
  }
  return token.value;
}

/**
 * Best-effort wake-up only: an authenticated check-in fetches the actual command.
 * The token is never used for authentication or placed inside the FCM payload.
 */
export async function wakeDeviceToken(pushToken: string, deviceId: string): Promise<boolean> {
  if (!pushToken) return false;
  try {
    const account = await credentials();
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await accessToken()}`,
        },
        body: JSON.stringify({
          message: {
            token: pushToken,
            data: { action: 'checkin' },
            android: { priority: 'HIGH', collapse_key: 'qist-checkin', ttl: '300s' },
          },
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (response.ok) return true;
    logger.warn('FCM wake-up failed', { deviceId, status: response.status });
  } catch (err) {
    logger.warn('FCM wake-up unavailable; periodic check-in may continue', { deviceId, err: String(err) });
  }
  return false;
}

/** Normal finance commands continue using the current enrollment's registered FCM token. */
export async function wakeDevice(orgId: Types.ObjectId, deviceId: Types.ObjectId): Promise<void> {
  try {
    const device = await Device.findOne({ _id: deviceId, orgId }).select('enrollment.pushToken').lean();
    await wakeDeviceToken(device?.enrollment?.pushToken ?? '', String(deviceId));
  } catch (err) {
    logger.warn('FCM wake-up unavailable; periodic check-in remains active', { deviceId: String(deviceId), err: String(err) });
  }
}

export interface CustomerPushDelivery { result: 'sent' | 'gone' | 'retry'; retryAfterSeconds: number }

/** Do not delete valid registrations for a bad payload or a Firebase project/auth configuration error. */
export function customerPushDisposition(status: number, body: unknown): CustomerPushDelivery['result'] {
  if (status >= 200 && status < 300) return 'sent';
  const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
  const details = error && typeof error === 'object' && 'details' in error && Array.isArray(error.details) ? error.details : [];
  const badPayload = details.some((d: unknown) => d && typeof d === 'object' && '@type' in d && d['@type'] === 'type.googleapis.com/google.rpc.BadRequest');
  const invalidToken = details.some((d: unknown) => d && typeof d === 'object' && '@type' in d && 'errorCode' in d &&
    d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' &&
    ((status === 404 && d.errorCode === 'UNREGISTERED') || (status === 400 && d.errorCode === 'INVALID_ARGUMENT' && !badPayload)));
  return invalidToken ? 'gone' : 'retry';
}

export function pushRetryAfterSeconds(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const header = value.trim();
  const seconds = /^\d+$/.test(header) ? Number(header) : /GMT$/i.test(header) ? (Date.parse(header) - now) / 1000 : 0;
  // Longer waits exceed the inbox event's retention period and will expire without another delivery.
  return Number.isFinite(seconds) ? Math.min(90 * 86400, Math.max(0, Math.ceil(seconds))) : 0;
}

/** Generic notification only; names, amounts and lock state stay behind the customer API. */
export async function sendCustomerPush(token: string, eventId: string): Promise<CustomerPushDelivery> {
  try {
    const account = await credentials();
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
      body: JSON.stringify({ message: {
        token, data: { action: 'customer_changed', eventId },
        android: { priority: 'HIGH', collapse_key: 'qist-customer-updates', ttl: '86400s' },
      } }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) return { result: 'sent', retryAfterSeconds: 0 };
    if (response.status === 401) accessTokenPromise = undefined;
    const retryAfterSeconds = pushRetryAfterSeconds(response.headers.get('Retry-After'));
    const body: unknown = await response.json().catch(() => null);
    const result = customerPushDisposition(response.status, body);
    if (result !== 'gone') logger.warn('Customer notification delivery failed', { status: response.status });
    return { result, retryAfterSeconds };
  } catch { logger.warn('Customer notification delivery unavailable'); }
  return { result: 'retry', retryAfterSeconds: 0 };
}
