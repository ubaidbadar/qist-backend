import type { Context, MiddlewareHandler } from 'hono';
import { env } from '../config/env';
import { RateLimitError } from '../lib/errors';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Off in integration tests, where every request comes from the same address. */
  enabled?: boolean;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Above this many tracked clients, expired windows are swept so memory stays bounded. */
const SWEEP_THRESHOLD = 10_000;

type BunServer = { requestIP?: (request: Request) => { address: string } | null };

function clientIp(c: Context): string {
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  // Bun.serve passes the server as the fetch handler's second argument (Hono's `c.env`).
  const server = c.env as BunServer | undefined;
  return server?.requestIP?.(c.req.raw)?.address ?? 'unknown';
}

/**
 * Fixed-window limit per client IP, kept in this process's memory. Enough for one container;
 * several instances would each allow `max`, so move the counters to a shared store before scaling out.
 */
export function rateLimit({ windowMs, max, enabled = true }: RateLimitOptions): MiddlewareHandler {
  const windows = new Map<string, Window>();

  return async (c, next) => {
    if (!enabled) return next();
    const now = Date.now();
    if (windows.size > SWEEP_THRESHOLD) {
      for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
    }

    const key = clientIp(c);
    const current = windows.get(key);
    const window = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
    window.count += 1;
    windows.set(key, window);

    if (window.count > max) throw new RateLimitError(Math.ceil((window.resetAt - now) / 1000));
    await next();
  };
}
