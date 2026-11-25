import { DurableObject } from 'cloudflare:workers';

export class DocumentProcessor extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({
        enableInternet: true,
        env: { DOCUMENT_PROCESSOR_SECRET: this.env.DOCUMENT_PROCESSOR_SECRET },
      });
    }
    await container.setInactivityTimeout(15 * 60 * 1000);
    const endpoint = new URL(request.url);
    endpoint.protocol = 'http:';
    endpoint.host = 'container';
    try {
      const forwarded = new Request(endpoint, request);
      forwarded.headers.delete('host');
      return await container.getTcpPort(3030).fetch(forwarded);
    } catch {
      // The API's durable job retries while freshclam initializes the container.
      return new Response('Processor unavailable', { status: 503 });
    }
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!(request.method === 'GET' && path === '/health') &&
        !(request.method === 'POST' && path === '/process')) {
      return new Response(null, { status: 404 });
    }
    const secret = env.DOCUMENT_PROCESSOR_SECRET;
    if (!secret || secret.length < 32) return new Response(null, { status: 503 });
    const bytes = new TextEncoder();
    const supplied = bytes.encode(request.headers.get('Authorization') || '');
    const expected = bytes.encode('Bearer ' + secret);
    if (supplied.length !== expected.length || !crypto.subtle.timingSafeEqual(supplied, expected)) {
      return new Response(null, { status: 401 });
    }
    return env.PROCESSOR.getByName('documents').fetch(request);
  },
};
