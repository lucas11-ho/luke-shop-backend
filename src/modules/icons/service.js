import { errors } from '../../core/errors.js';

export const ICON_USAGE_SCOPES=Object.freeze(['NAVIGATION','TOPIC','CATEGORY','ACCOUNT','ACTION']);
export const ICON_COLOR_MODES=Object.freeze(['THEME','DUOTONE','ORIGINAL']);
export const ICON_LIBRARY_PACKS=Object.freeze(['PHOSPHOR']);
export const PHOSPHOR_ICON_NAMES=Object.freeze([
  'house','storefront','squares-four','shopping-bag','basket','handbag','receipt','clipboard-text','package','list-checks',
  'user-circle','user','heart','star','compass','magnifying-glass','tag','gift','bell','map-pin',
]);

const KEY=/^[A-Z0-9][A-Z0-9._-]{2,79}$/;
const PHOSPHOR=new Set(PHOSPHOR_ICON_NAMES);
const SCOPES=new Set(ICON_USAGE_SCOPES);
const MODES=new Set(ICON_COLOR_MODES);

export const normalizeIconKey=value=>{
  const key=String(value||'').trim().toUpperCase();
  if(!KEY.test(key)) throw errors.badRequest('ICON_KEY_INVALID','Icon key must be 3-80 uppercase letters, numbers, dots, dashes or underscores');
  return key;
};

export function normalizeUsageScopes(value,{minItems=1}={}){
  if(!Array.isArray(value)) throw errors.badRequest('ICON_SCOPES_INVALID','Icon usage scopes must be an array');
  const scopes=[...new Set(value.map(v=>String(v||'').trim().toUpperCase()).filter(Boolean))];
  if(scopes.length<minItems) throw errors.badRequest('ICON_SCOPES_REQUIRED','At least one icon usage scope is required');
  for(const scope of scopes) if(!SCOPES.has(scope)) throw errors.badRequest('ICON_SCOPE_UNSUPPORTED',`Unsupported icon usage scope: ${scope}`);
  return scopes;
}

export function normalizeLibraryIconInput(raw={}){
  const libraryPack=String(raw.library_pack||'').trim().toUpperCase();
  const libraryIcon=String(raw.library_icon||'').trim().toLowerCase();
  const colorMode=String(raw.color_mode||'THEME').trim().toUpperCase();
  if(!ICON_LIBRARY_PACKS.includes(libraryPack)) throw errors.badRequest('ICON_PACK_UNSUPPORTED','Unsupported icon library pack');
  if(libraryPack==='PHOSPHOR'&&!PHOSPHOR.has(libraryIcon)) throw errors.badRequest('ICON_GLYPH_UNSUPPORTED','Icon glyph is not supported by the current renderer');
  if(!MODES.has(colorMode)) throw errors.badRequest('ICON_COLOR_MODE_UNSUPPORTED','Unsupported icon color mode');
  const name=String(raw.name||'').trim();
  if(name.length<2||name.length>120) throw errors.badRequest('ICON_NAME_INVALID','Icon name must be 2-120 characters');
  const tags=Array.isArray(raw.tags)?[...new Set(raw.tags.map(v=>String(v||'').trim().toLowerCase()).filter(Boolean))].slice(0,20):[];
  return {
    key:normalizeIconKey(raw.key),name,source_type:'LIBRARY',library_pack:libraryPack,library_icon:libraryIcon,
    color_mode:colorMode,usage_scopes:normalizeUsageScopes(raw.usage_scopes),tags,
  };
}

export function publicPlatformIcon(row){
  if(!row)return null;
  return {
    key:row.key,name:row.name,source_type:row.source_type,library_pack:row.library_pack,library_icon:row.library_icon,
    color_mode:row.color_mode,usage_scopes:row.usage_scopes||[],tags:row.tags||[],status:row.status,
    published_at:row.published_at||null,retired_at:row.retired_at||null,
  };
}

export async function listPlatformIcons(db,{status=null,scope=null}={}){
  const params=[];const where=[];
  if(status){params.push(String(status).trim().toUpperCase());where.push(`status=$${params.length}`)}
  if(scope){const normalized=String(scope).trim().toUpperCase();if(!SCOPES.has(normalized))throw errors.badRequest('ICON_SCOPE_UNSUPPORTED',`Unsupported icon usage scope: ${normalized}`);params.push(JSON.stringify([normalized]));where.push(`usage_scopes @> $${params.length}::jsonb`)}
  const result=await db.query(`SELECT * FROM platform_icons${where.length?` WHERE ${where.join(' AND ')}`:''} ORDER BY name ASC,key ASC`,params);
  return result.rows.map(publicPlatformIcon);
}

export async function requirePublishedPlatformGlyphs(db,{scope,libraryPack,glyphs,errorCode='PLATFORM_ICON_NOT_ALLOWED'}={}){
  const normalizedScope=String(scope||'').trim().toUpperCase();
  const normalizedPack=String(libraryPack||'').trim().toUpperCase();
  if(!SCOPES.has(normalizedScope)) throw errors.badRequest('ICON_SCOPE_UNSUPPORTED',`Unsupported icon usage scope: ${normalizedScope}`);
  if(!ICON_LIBRARY_PACKS.includes(normalizedPack)) throw errors.badRequest('ICON_PACK_UNSUPPORTED','Unsupported icon library pack');
  const requested=[...new Set((Array.isArray(glyphs)?glyphs:[]).map(v=>String(v||'').trim().toLowerCase()).filter(Boolean))];
  if(!requested.length)return[];
  const result=await db.query(
    `SELECT library_icon FROM platform_icons
      WHERE status='PUBLISHED' AND source_type='LIBRARY' AND library_pack=$1
        AND usage_scopes @> $2::jsonb AND library_icon=ANY($3::text[])`,
    [normalizedPack,JSON.stringify([normalizedScope]),requested],
  );
  const allowed=new Set(result.rows.map(row=>String(row.library_icon||'').toLowerCase()));
  const missing=requested.filter(glyph=>!allowed.has(glyph));
  if(missing.length)throw errors.badRequest(errorCode,`Platform Owner has not published ${missing.join(', ')} for ${normalizedScope.toLowerCase()} use`);
  return requested;
}

export async function findPlatformIcon(db,key,{forUpdate=false}={}){
  const result=await db.query(`SELECT * FROM platform_icons WHERE key=$1${forUpdate?' FOR UPDATE':''}`,[normalizeIconKey(key)]);
  if(!result.rowCount)throw errors.notFound('PLATFORM_ICON_NOT_FOUND','Platform icon not found');
  return result.rows[0];
}
