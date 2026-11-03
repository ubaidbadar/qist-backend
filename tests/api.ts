import type { ApiError, Session, User, UserWithTemporaryPassword } from '@shop/shared';
import { createApp } from '../src/app';
import { connectDb } from '../src/db/client';
import { ensureIndexes } from '../src/db/indexes';
import { testOutbox } from '../src/lib/email';

/** Helpers for integration tests: call the API in-process, sign up organizations, read sent emails. */
const app = createApp();

export const PASSWORD = 'correct horse battery';

export interface ApiResult<T> {
  status: number;
  data: T;
  error: ApiError | undefined;
  /** `qist_refresh=<value>` from Set-Cookie, ready to send back as a Cookie header. */
  refreshCookie: string | undefined;
  rawCookie: string | undefined;
}

interface CallOptions {
  body?: unknown;
  token?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

export async function call<T = unknown>(method: string, path: string, { body, token, cookie, headers: extra = {} }: CallOptions = {}) {
  const headers = new Headers(extra);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (cookie) headers.set('Cookie', cookie);

  const res = await app.request(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { data: T; error?: ApiError };
  const rawCookie = res.headers.getSetCookie().find((value) => value.startsWith('qist_refresh='));
  return { status: res.status, data: json.data, error: json.error, refreshCookie: rawCookie?.split(';')[0], rawCookie } satisfies ApiResult<T>;
}

export const prepareDatabase = async () => {
  await connectDb();
  await ensureIndexes();
};

let emailCounter = 0;
export const uniqueEmail = (label: string) => `${label}.${Date.now().toString(36)}${(emailCounter++).toString(36)}@example.com`;

export async function signupOrg(orgName = 'Test Mobiles') {
  const email = uniqueEmail('owner');
  const res = await call<Session>('POST', '/auth/signup', {
    body: { orgName, branchName: 'Main Branch', fullName: 'Owner Person', email, password: PASSWORD },
  });
  if (res.status !== 201 || !res.refreshCookie) throw new Error(`Signup failed: ${res.status} ${res.error?.message}`);
  return { email, session: res.data, token: res.data.accessToken, cookie: res.refreshCookie };
}

/** Adds a manager or staff member through the API and signs them in with their temporary password. */
export async function addMember(ownerToken: string, role: User['role'], branchIds: string[]) {
  const email = uniqueEmail(role);
  const created = await call<UserWithTemporaryPassword>('POST', '/users', {
    token: ownerToken,
    body: { fullName: `A ${role}`, email, role, branchIds },
  });
  if (created.status !== 201) throw new Error(`Adding member failed: ${created.status} ${created.error?.message}`);
  const login = await call<Session>('POST', '/auth/login', { body: { email, password: created.data.temporaryPassword } });
  return { ...created.data, email, token: login.data.accessToken, cookie: login.refreshCookie };
}

/** The token from the newest email sent to `to` (verification or reset link). */
export function tokenFromLastEmail(to: string) {
  const message = testOutbox.findLast((email) => email.to === to);
  const link = message?.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`No link emailed to ${to}`);
  return new URL(link).searchParams.get('token') ?? '';
}

const randomDigits = (count: number) => Array.from({ length: count }, () => Math.floor(Math.random() * 10)).join('');

/** A random IMEI with a valid Luhn check digit. */
export function randomImei() {
  const body = randomDigits(14);
  let sum = 0;
  for (let position = 0; position < body.length; position += 1) {
    let digit = Number(body[body.length - 1 - position]);
    if (position % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return body + String((10 - (sum % 10)) % 10);
}

export const randomCnic = () => randomDigits(13);
export const randomMobile = () => `03${randomDigits(9)}`;

export const newCustomer = (homeBranchId: string, overrides: Record<string, unknown> = {}) => ({
  homeBranchId,
  fullName: 'Muhammad Usman',
  fatherName: 'Abdul Ghani',
  cnic: randomCnic(),
  phone: randomMobile(),
  address: 'House 12, Street 4, Gulberg III, Lahore',
  ...overrides,
});
