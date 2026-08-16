import { errors } from '../../core/errors.js';

export async function getTenantBySlug(db, slug, { requireActive = true } = {}) {
  const result = await db.query(
    `SELECT t.id, t.public_id, t.slug, t.name, t.status,
            s.currency, s.locale, s.timezone, s.modules, s.branding, s.customer_service, ci.id_prefix AS customer_id_prefix, ci.auth_config AS customer_auth
       FROM tenants t
       JOIN tenant_settings s ON s.tenant_id = t.id
       JOIN tenant_customer_identity_settings ci ON ci.tenant_id=t.id
      WHERE t.slug = $1`,
    [slug],
  );
  if (!result.rowCount) throw errors.notFound('TENANT_NOT_FOUND', 'Store not found');
  const tenant = result.rows[0];
  if (requireActive && tenant.status !== 'ACTIVE') {
    throw errors.forbidden('TENANT_UNAVAILABLE', 'Store is currently unavailable');
  }
  return tenant;
}

export async function getTenantById(db, tenantId) {
  const result = await db.query(
    `SELECT t.id, t.public_id, t.slug, t.name, t.status,
            s.currency, s.locale, s.timezone, s.modules, s.branding, s.customer_service, ci.id_prefix AS customer_id_prefix, ci.auth_config AS customer_auth
       FROM tenants t
       JOIN tenant_settings s ON s.tenant_id = t.id
       JOIN tenant_customer_identity_settings ci ON ci.tenant_id=t.id
      WHERE t.id = $1`,
    [tenantId],
  );
  if (!result.rowCount) throw errors.notFound('TENANT_NOT_FOUND', 'Tenant not found');
  return result.rows[0];
}
