/** Standalone private processor. Deploy with its own memory/CPU limit and an internal-only network. */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDocument } from './validate_file';
import { UnsafeDocumentError } from './errors';

export function createDocumentProcessor(secret: string, scan: (path: string) => Promise<void>) {
  if (secret.length < 32) throw new Error('A private processor secret is required');
  let busy = false;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const actual = Buffer.from(c.req.header('Authorization') ?? '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return c.json({ error: 'Unauthorized' }, 401);
    if (busy) return c.json({ error: 'Busy' }, 429);
    busy = true;
    try {
      await next();
    } finally {
      busy = false;
    }
  });
  app.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 }));
  app.get('/health', (c) => c.json({ ready: true }));
  app.post('/process', async (c) => {
    const dir = await mkdtemp(join(tmpdir(), 'qist-check-'));
    const path = join(dir, 'source');
    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (!bytes.byteLength) return c.json({ error: 'Invalid file' }, 422);
      await writeFile(path, bytes, { mode: 0o600 });
      await scan(path);
      const result = await validateDocument(bytes);
      return c.json({
        contentType: result.contentType,
        data: Buffer.from(result.bytes).toString('base64'),
        preview: result.preview ? Buffer.from(result.preview).toString('base64') : null,
      });
    } catch (error) {
      return error instanceof UnsafeDocumentError
        ? c.json({ error: 'Unsafe file' }, 422)
        : c.json({ error: 'File checks unavailable' }, 503);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  return app;
}
if (import.meta.main) {
  const secret = process.env.DOCUMENT_PROCESSOR_SECRET ?? '';
  const scanner = process.env.DOCUMENTS_SCANNER ?? '/usr/bin/clamscan';
  const app = createDocumentProcessor(secret, async (path) => {
    const marker = process.env.AV_UPDATE_MARKER;
    if (!marker || Date.now() - (await stat(marker)).mtimeMs > 48 * 60 * 60_000)
      throw new Error('Scanner database is stale');
    const child = Bun.spawn([scanner, '--no-summary', '--stdout', path], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 60_000,
    });
    const code = await child.exited;
    if (code === 1) throw new UnsafeDocumentError('Unsafe file');
    if (code !== 0) throw new Error('Scanner unavailable');
  });
  Bun.serve({
    port: Number(process.env.PORT ?? 3030),
    fetch: app.fetch,
    maxRequestBodySize: 10 * 1024 * 1024,
    idleTimeout: 60,
  });
}
