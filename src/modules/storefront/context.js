import { createHash } from 'node:crypto';
import { errors } from '../../core/errors.js';
import { normalizeSlug } from '../../core/identifiers.js';
import { getTenantBySlug } from '../tenants/service.js';
import { resolveStore, resolveStoreBySlug } from '../catalog/service.js';
import { resolveStatusVisualPack } from '../customer-experience/service.js';
import { publicThemePackage, resolveThemePackage } from '../themes/selection-service.js';

export function normalizeHostname(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '').split(':')[0];
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) {
    throw errors.badRequest('STOREFRONT_HOST_INVALID', 'Invalid storefront hostname');
  }
  return host;
}

function hostedTenantSlug(hostname, suffix) {
  const normalizedSuffix = String(suffix || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!normalizedSuffix) return null;
  const tail = `.${normalizedSuffix}`;
  if (!hostname.endsWith(tail)) return null;
  const label = hostname.slice(0, -tail.length);
  if (!label || label.includes('.')) return null;
  try { return normalizeSlug(label); } catch { return null; }
}

export async function resolvePublicStorefront(db, config, { tenantSlug = null, storeSlug = null, hostname = null } = {}) {
  if (tenantSlug) {
    let slug;
    try { slug = normalizeSlug(tenantSlug); } catch { throw errors.notFound('STOREFRONT_NOT_FOUND', 'Storefront not found'); }
    const tenant = await getTenantBySlug(db, slug, { requireActive: true });
    const store = await resolveStoreBySlug(db, tenant.id, storeSlug || null, { requireActive: true });
    return { tenant, store, source: 'TENANT_ROUTE', hostname: null };
  }

  if (hostname) {
    const host = normalizeHostname(hostname);
    const domain = await db.query(
      `SELECT d.hostname,t.id AS tenant_id,t.public_id AS tenant_public_id,t.slug AS tenant_slug,t.name AS tenant_name,t.status AS tenant_status,
              ts.currency,ts.locale,ts.timezone,ts.modules,ts.branding,ts.customer_service,
              s.id AS store_id,s.public_id AS store_public_id,s.slug AS store_slug,s.name AS store_name,s.status AS store_status,s.is_primary
         FROM storefront_domains d
         JOIN tenants t ON t.id=d.tenant_id
         JOIN tenant_settings ts ON ts.tenant_id=t.id
         LEFT JOIN stores s ON s.id=COALESCE(d.store_id,(SELECT ps.id FROM stores ps WHERE ps.tenant_id=t.id AND ps.is_primary=true LIMIT 1))
        WHERE d.hostname=$1 AND d.status='VERIFIED' LIMIT 1`, [host],
    );
    if (domain.rowCount) {
      const row = domain.rows[0];
      if (row.tenant_status !== 'ACTIVE' || row.store_status !== 'ACTIVE') throw errors.forbidden('TENANT_UNAVAILABLE', 'Store is currently unavailable');
      return {
        source: 'CUSTOM_DOMAIN', hostname: host,
        tenant: { id: row.tenant_id, public_id: row.tenant_public_id, slug: row.tenant_slug, name: row.tenant_name, status: row.tenant_status,
          currency: row.currency, locale: row.locale, timezone: row.timezone, modules: row.modules, branding: row.branding, customer_service: row.customer_service },
        store: { id: row.store_id, public_id: row.store_public_id, slug: row.store_slug, name: row.store_name, status: row.store_status, is_primary: row.is_primary },
      };
    }
    const slug = hostedTenantSlug(host, config.storefrontHostSuffix);
    if (slug) {
      const tenant = await getTenantBySlug(db, slug, { requireActive: true });
      const store = await resolveStore(db, tenant.id, null, { requireActive: true });
      return { tenant, store, source: 'HOSTED_SUBDOMAIN', hostname: host };
    }
    throw errors.notFound('STOREFRONT_NOT_FOUND', 'Storefront not found');
  }

  throw errors.badRequest('STOREFRONT_CONTEXT_REQUIRED', 'Tenant route or storefront hostname is required');
}

export async function storefrontPayload(db, { tenant, store, source = 'HEADER', hostname = null, experience = null, experienceVersion = null, preview = false }) {
  const [experienceResult, profileResult] = await Promise.all([
    experience ? Promise.resolve({ rows: [{ config: experience, version: experienceVersion }] }) : db.query(
      `SELECT version,config FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2 AND state='PUBLISHED' ORDER BY version DESC LIMIT 1`,
      [tenant.id, store.id],
    ),
    db.query(`SELECT p.capabilities AS overrides,pl.capabilities AS plan FROM tenant_platform_profiles p JOIN platform_plans pl ON pl.key=p.plan_key WHERE p.tenant_id=$1`, [tenant.id]),
  ]);
  const capRow = profileResult.rows[0] || {};
  const capabilities = { ...(capRow.plan || {}), ...(capRow.overrides || {}) };
  const rawExperience = experienceResult.rows[0]?.config || null;
  const [statusVisualPack, resolvedThemePackage] = rawExperience ? await Promise.all([
    resolveStatusVisualPack(db, rawExperience),
    rawExperience.theme_package ? resolveThemePackage(db, rawExperience.theme_package, { app:'CUSTOMER_WEB', publishedOnly:false }) : Promise.resolve(null),
  ]) : [null, null];
  const publicExperience = rawExperience ? {
    ...rawExperience,
    status_visuals: statusVisualPack ? { pack_key: statusVisualPack.key, name: statusVisualPack.name, icons: statusVisualPack.icons || {}, settings: statusVisualPack.settings || {} } : null,
  } : null;
  const storePath = `/t/${tenant.slug}${store.is_primary || !store.slug || store.slug === 'main' ? '' : `/s/${store.slug}`}`;
  return {
    tenant: {
      id: tenant.public_id, slug: tenant.slug, name: tenant.name,
      currency: tenant.currency, locale: tenant.locale, timezone: tenant.timezone,
      modules: tenant.modules, branding: tenant.branding,
    },
    store: { id: store.public_id, slug: store.slug || null, name: store.name, is_primary: store.is_primary },
    routing: { source, hostname, storefront_path: storePath, preview: Boolean(preview) },
    channels: { customer_web: capabilities.customer_web !== false, customer_mobile: capabilities.customer_mobile !== false },
    experience: publicExperience,
    experience_version: experienceResult.rows[0]?.version || null,
    theme_package: publicThemePackage(resolvedThemePackage),
    customer_service: {
      enabled: Boolean(tenant.customer_service?.enabled), provider: tenant.customer_service?.provider || null,
      placement: tenant.customer_service?.placement || {}, label: tenant.customer_service?.label || 'Customer Support',
      chat_url: /^https:\/\//i.test(String(tenant.customer_service?.chat_url||'')) ? String(tenant.customer_service.chat_url) : null,
      platform_route_key: String(tenant.customer_service?.platform_route_key||'').trim() || null,
      commerce_context_version: 2,
    },
  };
}

export async function resolvePreviewToken(db, rawToken) {
  const token = String(rawToken || '').trim();
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw errors.notFound('STOREFRONT_PREVIEW_NOT_FOUND', 'Preview link is invalid or expired');
  const hash = createHash('sha256').update(token).digest('hex');
  const result = await db.query(
    `SELECT pt.tenant_id,pt.store_id,pt.experience_version,
            t.public_id AS tenant_public_id,t.slug AS tenant_slug,t.name AS tenant_name,t.status AS tenant_status,
            ts.currency,ts.locale,ts.timezone,ts.modules,ts.branding,ts.customer_service,
            s.public_id AS store_public_id,s.slug AS store_slug,s.name AS store_name,s.status AS store_status,s.is_primary,
            x.config
       FROM storefront_preview_tokens pt
       JOIN tenants t ON t.id=pt.tenant_id
       JOIN tenant_settings ts ON ts.tenant_id=t.id
       JOIN stores s ON s.id=pt.store_id AND s.tenant_id=pt.tenant_id
       JOIN storefront_experience_versions x ON x.tenant_id=pt.tenant_id AND x.store_id=pt.store_id AND x.version=pt.experience_version AND x.state='DRAFT'
      WHERE pt.token_hash=$1 AND pt.revoked_at IS NULL AND pt.expires_at>now() LIMIT 1`, [hash],
  );
  if (!result.rowCount) throw errors.notFound('STOREFRONT_PREVIEW_NOT_FOUND', 'Preview link is invalid or expired');
  const row = result.rows[0];
  if (row.tenant_status !== 'ACTIVE' || row.store_status !== 'ACTIVE') throw errors.forbidden('TENANT_UNAVAILABLE', 'Store is currently unavailable');
  return {
    tenant: { id: row.tenant_id, public_id: row.tenant_public_id, slug: row.tenant_slug, name: row.tenant_name, status: row.tenant_status,
      currency: row.currency, locale: row.locale, timezone: row.timezone, modules: row.modules, branding: row.branding, customer_service: row.customer_service },
    store: { id: row.store_id, public_id: row.store_public_id, slug: row.store_slug, name: row.store_name, status: row.store_status, is_primary: row.is_primary },
    experience: row.config, experienceVersion: row.experience_version,
  };
}
