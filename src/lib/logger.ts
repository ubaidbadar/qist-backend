import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Personal data and credentials never reach the logs, whatever object they are nested in.
const SENSITIVE_KEY = /cnic|phone|password|token|secret|authorization|cookie/i;
const REDACTED = '[redacted]';

export function redact(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(inner)]),
    );
  }
  return value;
}

function write(level: Level, message: string, fields: Record<string, unknown> = {}) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[env.LOG_LEVEL]) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...(redact(fields) as object) });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/** JSON-lines logger with redaction of sensitive fields. */
export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
