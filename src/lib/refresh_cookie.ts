import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { env } from '../config/env';

const REFRESH_COOKIE = 'qist_refresh';
/** Sent only to the auth endpoints that need it (refresh, logout), never with ordinary API calls. */
const COOKIE_PATH = '/api/v1/auth';

const cookieOptions = () =>
  ({
    path: COOKIE_PATH,
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'None' : 'Lax',
    partitioned: env.NODE_ENV === 'production',
  }) as const;

export const setRefreshCookie = (c: Context, token: string, expires: Date) =>
  setCookie(c, REFRESH_COOKIE, token, { ...cookieOptions(), expires });

export const readRefreshCookie = (c: Context) => getCookie(c, REFRESH_COOKIE);

export const clearRefreshCookie = (c: Context) => deleteCookie(c, REFRESH_COOKIE, cookieOptions());
