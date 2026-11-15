import { publicController } from '../lib/factory';
import { NotFoundError } from '../lib/errors';
import { parseId } from '../lib/ids';
import { OrgLogo } from '../models/org_logo';

/** GET /public/orgs/:orgId/logo — public, immutable image bytes; the org ID is not a secret. */
export const show = publicController.createHandlers(async (c) => {
  const orgId = parseId(c.req.param('orgId'), 'Organization');
  const logo = await OrgLogo.findById(orgId).select('+data contentType').lean();
  if (!logo) throw new NotFoundError('Organization logo');

  c.header('Content-Type', logo.contentType);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(Uint8Array.from(logo.data));
});
