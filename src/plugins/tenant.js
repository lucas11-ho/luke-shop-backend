import { errors } from '../core/errors.js';
import { normalizeSlug } from '../core/identifiers.js';
import { getTenantBySlug } from '../modules/tenants/service.js';

export function tenantPlugin(app) {
  app.decorateRequest('tenant', null);

  app.decorate('requireTenant', async function requireTenant(request) {
    const header = request.headers['x-tenant-slug'];
    if (!header || Array.isArray(header)) {
      throw errors.badRequest('TENANT_REQUIRED', 'x-tenant-slug header is required');
    }
    let slug;
    try {
      slug = normalizeSlug(header);
    } catch {
      throw errors.badRequest('TENANT_INVALID', 'Invalid tenant identifier');
    }
    request.tenant = await getTenantBySlug(app.db, slug, { requireActive: true });
  });
}
