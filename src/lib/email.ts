import { createTransport } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Emails "sent" while testing, newest last; tests read links from here. */
export const testOutbox: EmailMessage[] = [];

const transport = env.SMTP_HOST
  ? createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
  : undefined;

/**
 * SMTP when a host is set, the console in development (so links can be clicked from the terminal),
 * and an in-memory outbox in tests.
 */
export async function sendEmail(message: EmailMessage) {
  if (env.NODE_ENV === 'test') {
    testOutbox.push(message);
  } else if (transport) {
    await transport.sendMail({ from: env.SMTP_FROM, ...message });
  } else {
    console.log(`\n[email to ${message.to}] ${message.subject}\n${message.text}\n`);
  }
}

/** For emails that must not fail the request that triggered them (the user can ask again). */
export function sendEmailInBackground(message: EmailMessage) {
  sendEmail(message).catch((err: unknown) => logger.error('Email could not be sent', { subject: message.subject, err }));
}
