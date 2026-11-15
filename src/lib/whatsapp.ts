import { env } from '../config/env';
import { AppError } from './errors';

/** Tests only. Production never logs or returns a verification code. */
export const whatsappTestOutbox: { phone: string; code: string }[] = [];
export const whatsappUnavailable = () => new AppError('SERVICE_UNAVAILABLE', 503, 'WhatsApp verification is unavailable. Please try again later.');

export function requireWhatsApp() {
  if (env.NODE_ENV === 'test') return;
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_AUTH_TEMPLATE || !env.WHATSAPP_GRAPH_VERSION) throw whatsappUnavailable();
}

/** Copy-code authentication template: the same OTP goes in the body and its URL button. */
export function whatsappCodeMessage(phone: string, code: string) {
  return {
    messaging_product: 'whatsapp', to: `92${phone.slice(1)}`, type: 'template',
    template: {
      name: env.WHATSAPP_AUTH_TEMPLATE, language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  };
}

export async function sendWhatsAppCode(phone: string, code: string) {
  requireWhatsApp();
  if (env.NODE_ENV === 'test') { whatsappTestOutbox.push({ phone, code }); return; }
  try {
    const response = await fetch(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(whatsappCodeMessage(phone, code)), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw whatsappUnavailable(); }
    const result = await response.json() as { messages?: { id?: string }[] };
    if (!result.messages?.[0]?.id) throw whatsappUnavailable();
  } catch (err) {
    // @ts-ignore
    console.log({ ...err, 'whatsapp' })
    // Never surface a provider response that might contain a recipient or credential.
    throw whatsappUnavailable();
  }
}
