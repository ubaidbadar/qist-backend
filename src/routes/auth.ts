import { env } from '../config/env';
import * as auth from '../controllers/auth_controller';
import * as emailLinks from '../controllers/email_links_controller';
import { createRouter } from '../lib/hono';
import { rateLimit } from '../middleware/rate_limit';

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_ATTEMPTS_PER_WINDOW = 20;

/** Per-IP limit against password guessing, email flooding and Google credential abuse. */
const limitAttempts = rateLimit({ windowMs: AUTH_WINDOW_MS, max: AUTH_ATTEMPTS_PER_WINDOW, enabled: env.NODE_ENV !== 'test' });

/** Public: signing in and out, and the links sent by email. */
export const authRoutes = createRouter()
  .get('/google/config', ...auth.googleConfig)
  .post('/google', limitAttempts, ...auth.googleSignIn)
  .post('/signup', limitAttempts, ...auth.signup)
  .post('/login', limitAttempts, ...auth.login)
  .post('/refresh', ...auth.refresh)
  .post('/logout', ...auth.logout)
  .post('/verify-email', limitAttempts, ...emailLinks.verifyEmail)
  .post('/forgot-password', limitAttempts, ...emailLinks.forgotPassword)
  .post('/reset-password', limitAttempts, ...emailLinks.resetPassword);
