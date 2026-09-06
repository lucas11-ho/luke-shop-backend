import { createHash } from 'node:crypto';
import { errors } from '../../core/errors.js';

export const ICON_USAGE_SCOPES=Object.freeze(['NAVIGATION','TOPIC','CATEGORY','ACCOUNT','ACTION']);
export const ICON_COLOR_MODES=Object.freeze(['THEME','DUOTONE','ORIGINAL']);
export const ICON_LIBRARY_PACKS=Object.freeze(['PHOSPHOR']);
export const ICON_SOURCE_TYPES=Object.freeze(['LIBRARY','CUSTOM_IMAGE']);
export const CUSTOM_IMAGE_MIME_TYPES=Object.freeze(['image/png','image/webp']);
export const CUSTOM_IMAGE_VARIANTS=Object.freeze(['DEFAULT','LIGHT','DARK']);
export const CUSTOM_IMAGE_MAX_BYTES=262144;
export const CUSTOM_IMAGE_MIN_DIMENSION=16;
export const CUSTOM_IMAGE_MAX_DIMENSION=512;
export const PHOSPHOR_ICON_NAMES=Object.freeze([
  'house','storefront','squares-four','shopping-bag','basket','handbag','receipt','clipboard-text','package','list-checks',
  'user-circle','user','heart','star','compass','magnifying-glass','tag','gift','bell','map-pin',
]);

const KEY=/^[A-Z0-9][A-Z0-9._-]{2,79}$/;
const BASE64=/^[A-Za-z0-9+/]+={0,2}$/;
const PHOSPHOR=new Set(PHOSPHOR_ICON_NAMES);
const SCOPES=new Set(ICON_USAGE_SCOPES);
const MODES=new Set(ICON_COLOR_MODES);
const MIME_TYPES=new Set(CUSTOM_IMAGE_MIME_TYPES);
const VARIANTS=new Set(CUSTOM_IMAGE_VARIANTS);
const ICON_SELECT=`SELECT i.*,
  a.mime_type AS asset_mime,a.byte_size AS asset_size_bytes,a.width AS asset_width,a.height AS asset_height,a.sha256 AS asset_sha256,
  EXISTS(SELECT 1 FROM platform_icon_assets al WHERE al.icon_id=i.id AND al.variant='LIGHT') AS has_light_asset,
  EXISTS(SELECT 1 FROM platform_icon_assets ad WHERE ad.icon_id=i.id AND ad.variant='DARK') AS has_dark_asset
  FROM platform_icons i LEFT JOIN platform_icon_assets a ON a.icon_id=i.id AND a.variant='DEFAULT'`;

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

function normalizeNameTags(raw={}){
  const name=String(raw.name||'').trim();
  if(name.length<2||name.length>120) throw errors.badRequest('ICON_NAME_INVALID','Icon name must be 2-120 characters');
  const tags=Array.isArray(raw.tags)?[...new Set(raw.tags.map(v=>String(v||'').trim().toLowerCase()).filter(Boolean))].slice(0,20):[];
  const category=String(raw.category||'').trim();
  if(category.length>80) throw errors.badRequest('ICON_CATEGORY_INVALID','Icon category must be 80 characters or fewer');
  return {name,tags,category:category||null};
}

export function normalizeLibraryIconInput(raw={}){
  const libraryPack=String(raw.library_pack||'').trim().toUpperCase();
  const libraryIcon=String(raw.library_icon||'').trim().toLowerCase();
  const colorMode=String(raw.color_mode||'THEME').trim().toUpperCase();
  if(!ICON_LIBRARY_PACKS.includes(libraryPack)) throw errors.badRequest('ICON_PACK_UNSUPPORTED','Unsupported icon library pack');
  if(libraryPack==='PHOSPHOR'&&!PHOSPHOR.has(libraryIcon)) throw errors.badRequest('ICON_GLYPH_UNSUPPORTED','Icon glyph is not supported by the current renderer');
  if(!MODES.has(colorMode)) throw errors.badRequest('ICON_COLOR_MODE_UNSUPPORTED','Unsupported icon color mode');
  const {name,tags,category}=normalizeNameTags(raw);
  return {
    key:normalizeIconKey(raw.key),name,category,source_type:'LIBRARY',library_pack:libraryPack,library_icon:libraryIcon,
    color_mode:colorMode,usage_scopes:normalizeUsageScopes(raw.usage_scopes),tags,
  };
}

function inspectPng(bytes){
  const sig=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if(bytes.length<24||!bytes.subarray(0,8).equals(sig)||bytes.toString('ascii',12,16)!=='IHDR') throw errors.badRequest('ICON_IMAGE_INVALID','PNG signature or IHDR is invalid');
  if(bytes.includes(Buffer.from('acTL'))) throw errors.badRequest('ICON_IMAGE_ANIMATED','Animated PNG icons are not supported');
  return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}

function readUInt24LE(bytes,offset){return bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16)}
function inspectWebp(bytes){
  if(bytes.length<30||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP') throw errors.badRequest('ICON_IMAGE_INVALID','WebP signature is invalid');
  const chunk=bytes.toString('ascii',12,16);
  if(chunk==='VP8X'){
    if(bytes[20]&0x02) throw errors.badRequest('ICON_IMAGE_ANIMATED','Animated WebP icons are not supported');
    return {width:1+readUInt24LE(bytes,24),height:1+readUInt24LE(bytes,27)};
  }
  if(chunk==='VP8L'){
    if(bytes[20]!==0x2f) throw errors.badRequest('ICON_IMAGE_INVALID','WebP lossless header is invalid');
    const b1=bytes[21],b2=bytes[22],b3=bytes[23],b4=bytes[24];
    return {width:1+(b1|((b2&0x3f)<<8)),height:1+(((b2&0xc0)>>6)|(b3<<2)|((b4&0x0f)<<10))};
  }
  if(chunk==='VP8 '){
    if(bytes[23]!==0x9d||bytes[24]!==0x01||bytes[25]!==0x2a) throw errors.badRequest('ICON_IMAGE_INVALID','WebP lossy frame header is invalid');
    return {width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff};
  }
  throw errors.badRequest('ICON_IMAGE_INVALID','Unsupported WebP encoding');
}

function normalizeImageAsset(raw,variant,{required=false}={}){
  if(raw==null&&!required)return null;
  const image=raw&&typeof raw==='object'?raw:{};
  const mime=String(image.mime_type||'').trim().toLowerCase();
  if(!MIME_TYPES.has(mime)) throw errors.badRequest('ICON_IMAGE_TYPE_UNSUPPORTED','Custom icons must be PNG or WebP');
  const encoded=String(image.data_base64||'').trim();
  if(!encoded||encoded.length%4!==0||!BASE64.test(encoded)) throw errors.badRequest('ICON_IMAGE_BASE64_INVALID','Custom icon image must be canonical base64 without a data URL');
  const bytes=Buffer.from(encoded,'base64');
  if(!bytes.length||bytes.length>CUSTOM_IMAGE_MAX_BYTES) throw errors.badRequest('ICON_IMAGE_SIZE_INVALID',`Custom icon image must be 1-${CUSTOM_IMAGE_MAX_BYTES} bytes`);
  const dimensions=mime==='image/png'?inspectPng(bytes):inspectWebp(bytes);
  if(dimensions.width<CUSTOM_IMAGE_MIN_DIMENSION||dimensions.height<CUSTOM_IMAGE_MIN_DIMENSION||dimensions.width>CUSTOM_IMAGE_MAX_DIMENSION||dimensions.height>CUSTOM_IMAGE_MAX_DIMENSION){
    throw errors.badRequest('ICON_IMAGE_DIMENSIONS_INVALID',`Custom icon dimensions must be ${CUSTOM_IMAGE_MIN_DIMENSION}-${CUSTOM_IMAGE_MAX_DIMENSION}px`);
  }
  return {variant,mime_type:mime,body:bytes,byte_size:bytes.length,width:dimensions.width,height:dimensions.height,sha256:createHash('sha256').update(bytes).digest('hex')};
}

export function normalizeCustomImageIconInput(raw={}){
  const {name,tags,category}=normalizeNameTags(raw);
  const assets=[normalizeImageAsset(raw.image,'DEFAULT',{required:true}),normalizeImageAsset(raw.light_image,'LIGHT'),normalizeImageAsset(raw.dark_image,'DARK')].filter(Boolean);
  return {
    key:normalizeIconKey(raw.key),name,category,source_type:'CUSTOM_IMAGE',library_pack:null,library_icon:null,color_mode:'ORIGINAL',
    usage_scopes:normalizeUsageScopes(raw.usage_scopes),tags,assets,
  };
}

export function publicPlatformIcon(row){
  if(!row)return null;
  const custom=row.source_type==='CUSTOM_IMAGE';
  return {
    key:row.key,name:row.name,category:row.category||null,source_type:row.source_type,library_pack:row.library_pack,library_icon:row.library_icon,
    color_mode:row.color_mode,usage_scopes:row.usage_scopes||[],tags:row.tags||[],status:row.status,
    asset_path:custom?`/v1/icon-assets/${encodeURIComponent(row.key)}`:null,
    asset_mime:custom?(row.asset_mime||null):null,asset_size_bytes:custom?(row.asset_size_bytes||null):null,
    asset_width:custom?(row.asset_width||null):null,asset_height:custom?(row.asset_height||null):null,asset_sha256:custom?(row.asset_sha256||null):null,
    asset_variants:custom?{light:Boolean(row.has_light_asset),dark:Boolean(row.has_dark_asset)}:null,
    published_at:row.published_at||null,retired_at:row.retired_at||null,
  };
}

export async function listPlatformIcons(db,{status=null,scope=null}={}){
  const params=[];const where=[];
  if(status){params.push(String(status).trim().toUpperCase());where.push(`i.status=$${params.length}`)}
  if(scope){const normalized=String(scope).trim().toUpperCase();if(!SCOPES.has(normalized))throw errors.badRequest('ICON_SCOPE_UNSUPPORTED',`Unsupported icon usage scope: ${normalized}`);params.push(JSON.stringify([normalized]));where.push(`i.usage_scopes @> $${params.length}::jsonb`)}
  const result=await db.query(`${ICON_SELECT}${where.length?` WHERE ${where.join(' AND ')}`:''} ORDER BY i.name ASC,i.key ASC`,params);
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
  const result=await db.query(`${ICON_SELECT} WHERE i.key=$1${forUpdate?' FOR UPDATE OF i':''}`,[normalizeIconKey(key)]);
  if(!result.rowCount)throw errors.notFound('PLATFORM_ICON_NOT_FOUND','Platform icon not found');
  return result.rows[0];
}

export async function getPlatformIconAsset(db,key,{variant='DEFAULT'}={}){
  const normalized=String(variant||'DEFAULT').trim().toUpperCase();
  if(!VARIANTS.has(normalized)) throw errors.badRequest('ICON_IMAGE_VARIANT_UNSUPPORTED','Unsupported icon image variant');
  const result=await db.query(`SELECT i.key,i.status,a.variant,a.mime_type,a.byte_size,a.width,a.height,a.sha256,a.body
    FROM platform_icons i JOIN LATERAL (
      SELECT aa.* FROM platform_icon_assets aa WHERE aa.icon_id=i.id AND aa.variant IN ($2,'DEFAULT')
      ORDER BY CASE WHEN aa.variant=$2 THEN 0 ELSE 1 END LIMIT 1
    ) a ON true WHERE i.key=$1`,[normalizeIconKey(key),normalized]);
  if(!result.rowCount)throw errors.notFound('PLATFORM_ICON_ASSET_NOT_FOUND','Platform icon asset not found');
  return result.rows[0];
}
