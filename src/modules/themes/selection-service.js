import { errors } from '../../core/errors.js';
import { resolveThemeComponents, validateThemeComponentOverrides } from './service.js';

const APP_SET = new Set(['CUSTOMER_WEB','STAFF_WEB']);
const KEY = /^[A-Z][A-Z0-9_]{1,79}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export function normalizeThemeSelection(raw, { nullable = true } = {}) {
  if (raw === null || raw === undefined || raw === false) {
    if (nullable) return null;
    throw errors.badRequest('THEME_SELECTION_REQUIRED', 'A theme package selection is required');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw errors.badRequest('THEME_SELECTION_INVALID', 'Theme selection must contain a key and version');
  }
  const key = String(raw.key || '').trim().toUpperCase();
  const version = String(raw.version || '').trim();
  if (!KEY.test(key)) throw errors.badRequest('THEME_KEY_INVALID', 'Theme key must use uppercase letters, numbers and underscores');
  if (!VERSION.test(version)) throw errors.badRequest('THEME_VERSION_INVALID', 'Theme version must use semantic versioning such as 1.0.0');
  return { key, version };
}

export async function resolveThemePackage(db, selection, { app = null, publishedOnly = false } = {}) {
  const normalized = normalizeThemeSelection(selection, { nullable:false });
  const normalizedApp = app ? String(app).trim().toUpperCase() : null;
  if (normalizedApp && !APP_SET.has(normalizedApp)) throw errors.badRequest('THEME_APP_INVALID', 'Unsupported theme application');
  const result = await db.query(
    `SELECT key,version,name,description,status,supported_apps,manifest,preview,created_at,updated_at,published_at
       FROM platform_theme_packages
      WHERE key=$1 AND version=$2
        AND ($3::boolean=false OR status='PUBLISHED')
        AND ($4::text IS NULL OR supported_apps ? $4)
      LIMIT 1`,
    [normalized.key, normalized.version, publishedOnly, normalizedApp],
  );
  if (!result.rowCount) throw errors.notFound('THEME_PACKAGE_NOT_AVAILABLE', 'Selected theme package is not available for this application');
  return result.rows[0];
}

export function publicThemePackage(row) {
  if (!row) return null;
  return {
    key: row.key,
    version: row.version,
    name: row.name,
    description: row.description || '',
    status: row.status,
    manifest: row.manifest || {},
    preview: {
      summary: row.preview?.summary || '',
      tags: Array.isArray(row.preview?.tags) ? row.preview.tags : [],
      thumbnail_url: row.preview?.thumbnail_url || '',
    },
  };
}

export async function getStaffThemeSelection(db, { tenantId, storeId }) {
  const result = await db.query(
    `SELECT theme_key,theme_version,component_overrides,updated_at
       FROM store_staff_theme_settings
      WHERE tenant_id=$1 AND store_id=$2`,
    [tenantId, storeId],
  );
  if (!result.rowCount || !result.rows[0].theme_key || !result.rows[0].theme_version) {
    return { selection:null, theme:null, component_overrides:{}, effective_components:{}, updated_at:result.rows[0]?.updated_at || null };
  }
  const selection = { key:result.rows[0].theme_key, version:result.rows[0].theme_version };
  const themeRow = await resolveThemePackage(db, selection, { app:'STAFF_WEB', publishedOnly:false });
  const overrides = validateThemeComponentOverrides(themeRow,'STAFF_WEB',result.rows[0].component_overrides || {});
  return { selection, theme:publicThemePackage(themeRow), component_overrides:overrides, effective_components:resolveThemeComponents(themeRow,'STAFF_WEB',overrides), updated_at:result.rows[0].updated_at };
}

export async function setStaffThemeSelection(client, { tenantId, storeId, actorId, selection, componentOverrides = {} }) {
  const normalized = normalizeThemeSelection(selection);
  if (!normalized) {
    await client.query('DELETE FROM store_staff_theme_settings WHERE tenant_id=$1 AND store_id=$2', [tenantId, storeId]);
    return { selection:null, theme:null, component_overrides:{}, effective_components:{}, updated_at:null };
  }
  const themeRow = await resolveThemePackage(client, normalized, { app:'STAFF_WEB', publishedOnly:true });
  const overrides = validateThemeComponentOverrides(themeRow,'STAFF_WEB',componentOverrides);
  const saved = await client.query(
    `INSERT INTO store_staff_theme_settings(tenant_id,store_id,theme_key,theme_version,component_overrides,updated_by,updated_at)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,now())
     ON CONFLICT(tenant_id,store_id) DO UPDATE
       SET theme_key=EXCLUDED.theme_key,theme_version=EXCLUDED.theme_version,component_overrides=EXCLUDED.component_overrides,updated_by=EXCLUDED.updated_by,updated_at=now()
     RETURNING updated_at`,
    [tenantId, storeId, normalized.key, normalized.version, JSON.stringify(overrides), actorId],
  );
  return { selection:normalized, theme:publicThemePackage(themeRow), component_overrides:overrides, effective_components:resolveThemeComponents(themeRow,'STAFF_WEB',overrides), updated_at:saved.rows[0].updated_at };
}