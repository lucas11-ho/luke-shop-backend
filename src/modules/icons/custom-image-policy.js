import { errors } from '../../core/errors.js';
import { ICON_USAGE_SCOPES, normalizeIconKey } from './service.js';

const SCOPES=new Set(ICON_USAGE_SCOPES);

export async function requirePublishedCustomImageIcons(db,{scope,keys,errorCode='PLATFORM_ICON_NOT_ALLOWED'}={}){
  const normalizedScope=String(scope||'').trim().toUpperCase();
  if(!SCOPES.has(normalizedScope))throw errors.badRequest('ICON_SCOPE_UNSUPPORTED',`Unsupported icon usage scope: ${normalizedScope}`);
  const requested=[...new Set((Array.isArray(keys)?keys:[]).map(key=>normalizeIconKey(key)))];
  if(!requested.length)return[];
  const result=await db.query(
    `SELECT i.key FROM platform_icons i
      WHERE i.status='PUBLISHED' AND i.source_type='CUSTOM_IMAGE'
        AND i.usage_scopes @> $1::jsonb AND i.key=ANY($2::text[])
        AND EXISTS(SELECT 1 FROM platform_icon_assets a WHERE a.icon_id=i.id AND a.variant='DEFAULT')`,
    [JSON.stringify([normalizedScope]),requested],
  );
  const allowed=new Set(result.rows.map(row=>String(row.key||'').toUpperCase()));
  const missing=requested.filter(key=>!allowed.has(key));
  if(missing.length)throw errors.badRequest(errorCode,`Platform Owner has not published ${missing.join(', ')} for ${normalizedScope.toLowerCase()} use`);
  return requested;
}
