import { z } from 'zod';

const secret = z.string().min(32, 'must be at least 32 characters');
/** Unset and empty (`KEY=` in .env) both mean "not configured". */
const optionalText = z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5001),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** Read the client IP from X-Forwarded-For; enable only behind a proxy that sets it. */
    TRUST_PROXY: z.stringbool().default(false),
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI'),
    MONGODB_DB: z.string().regex(/^[A-Za-z0-9_-]{1,38}$/, 'letters, digits, _ and - only'),
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    INTERNAL_JOB_SECRET: secret,
    APP_ORIGIN: z.url(),
    // Needed from the uploads / email phases on; required in production.
    R2_ACCOUNT_ID: optionalText,
    R2_ACCESS_KEY_ID: optionalText,
    R2_SECRET_ACCESS_KEY: optionalText,
    R2_BUCKET: optionalText,
    /** SMTP account for emails (Brevo relay). Unset in development prints emails to the console. */
    SMTP_HOST: optionalText,
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    /** true for implicit TLS (port 465); false for STARTTLS (port 587). */
    SMTP_SECURE: z.stringbool().default(false),
    SMTP_USER: optionalText,
    SMTP_PASS: optionalText,
    /** Sender for emails, e.g. `Qist <no-reply@example.com>`; the address must be verified with the SMTP provider. */
    SMTP_FROM: optionalText,
    /** Where phones download the device app during QR setup (https, ours). Needed to issue an enrolment QR. */
    DEVICE_APP_APK_URL: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
    /** SHA-256 of the device app's signing certificate, URL-safe base64 without padding (43 characters). */
    DEVICE_APP_SIGNATURE_CHECKSUM: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be URL-safe base64 of a SHA-256 hash, without padding').optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['JWT_REFRESH_SECRET'], message: 'must differ from JWT_ACCESS_SECRET' });
    }
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'DEVICE_APP_APK_URL', 'DEVICE_APP_SIGNATURE_CHECKSUM'] as const) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
    }
    if (env.DEVICE_APP_APK_URL && !env.DEVICE_APP_APK_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['DEVICE_APP_APK_URL'], message: 'must use https in production' });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Fails fast with every problem listed; values are never printed, only their names. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);
