import { APP_NAME } from '@shop/shared';
import { publicController } from '../lib/factory';

const API_REFERENCE = new URL('../../../docs/api.md', import.meta.url);

/** The page has its own inline stylesheet and nothing else, so it carries its own policy instead of the API's. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

const STYLE = `
  :root { color-scheme: light dark; }
  body { max-width: 60rem; margin: 0 auto; padding: 2rem 1rem 4rem; font: 15px/1.6 system-ui, sans-serif; }
  h2 { margin-top: 3rem; padding-bottom: 0.3rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  h3 { margin-top: 2rem; }
  table { display: block; overflow-x: auto; border-collapse: collapse; margin: 1rem 0; }
  th, td { padding: 0.4rem 0.75rem; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); text-align: left; vertical-align: top; }
  code { font: 0.9em ui-monospace, monospace; padding: 0.1em 0.3em; border-radius: 4px; background: color-mix(in srgb, currentColor 10%, transparent); }
  pre { overflow-x: auto; padding: 1rem; border-radius: 6px; background: color-mix(in srgb, currentColor 10%, transparent); }
  pre code { padding: 0; background: none; }
`;

/** GET /docs: docs/api.md as a web page. Development only; the file is not part of the production image. */
export const show = publicController.createHandlers(async (c) => {
  const markdown = await Bun.file(API_REFERENCE).text();
  const body = Bun.markdown.html(markdown, { headings: { ids: true } });
  c.header('Content-Security-Policy', PAGE_CSP);
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${APP_NAME} API reference</title><style>${STYLE}</style></head><body>${body}</body></html>`,
  );
});
