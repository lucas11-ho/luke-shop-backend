import { errors } from '../../core/errors.js';
import { ICON_USAGE_SCOPES, PHOSPHOR_ICON_NAMES, normalizeIconKey } from './service.js';

const SCOPES = new Set(ICON_USAGE_SCOPES);
const PHOSPHOR = new Set(PHOSPHOR_ICON_NAMES);

export async function validatePlatformIconReference(db, value, { scope, errorCode = 'PLATFORM_ICON_NOT_ALLOWED' } = {}) {
  if (value == null || String(value).trim() === '') return null;
  const normalizedScope = String(scope || '').trim().toUpperCase();
  if (!SCOPES.has(normalizedScope)) throw errors.badRequest('ICON_SCOPE_UNSUPPORTED', `Unsupported icon usage scope: ${normalizedScope}`);
  const key = normalizeIconKey(value);
  const result = await db.query(
    `SELECT i.key,i.source_type,i.library_pack,i.library_icon,
            EXISTS(SELECT 1 FROM platform_icon_assets a WHERE a.icon_id=i.id AND a.variant='DEFAULT') AS has_default_asset
       FROM platform_icons i
      WHERE i.key=$1 AND i.status='PUBLISHED' AND i.usage_scopes @> $2::jsonb`,
    [key, JSON.stringify([normalizedScope])],
  );
  if (!result.rowCount) throw errors.badRequest(errorCode, `Platform Owner has not published this icon for ${normalizedScope.toLowerCase()} use`);
  const icon = result.rows[0];
  const supported = icon.source_type === 'CUSTOM_IMAGE'
    ? Boolean(icon.has_default_asset)
    : icon.source_type === 'LIBRARY' && icon.library_pack === 'PHOSPHOR' && PHOSPHOR.has(String(icon.library_icon || '').toLowerCase());
  if (!supported) throw errors.badRequest(errorCode, `This Platform icon cannot be used for ${normalizedScope.toLowerCase()} presentation`);
  return key;
}

export function publicPlatformIconReference(row, prefix = 'icon') {
  const key = row?.[`${prefix}_key`] || null;
  if (!key) return null;
  const sourceType = row?.[`${prefix}_source_type`] || null;
  const custom = sourceType === 'CUSTOM_IMAGE';
  return {
    key,
    source_type: sourceType,
    library_pack: row?.[`${prefix}_library_pack`] || null,
    library_icon: row?.[`${prefix}_library_icon`] || null,
    color_mode: row?.[`${prefix}_color_mode`] || null,
    asset_path: custom ? `/v1/icon-assets/${encodeURIComponent(key)}` : null,
    asset_variants: custom ? {
      light: Boolean(row?.[`${prefix}_has_light_asset`]),
      dark: Boolean(row?.[`${prefix}_has_dark_asset`]),
    } : null,
  };
}
