import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { getPlatformIconAsset,listPlatformIcons,normalizeCustomImageIconInput } from '../src/modules/icons/service.js';

const db=createDatabase(loadConfig());
const suffix=randomUUID().replaceAll('-','').slice(0,10).toUpperCase();

function pngHeader(width=32,height=32,{animated=false}={}){
  const body=Buffer.alloc(animated?28:24);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(body,0);
  body.write('IHDR',12,'ascii');body.writeUInt32BE(width,16);body.writeUInt32BE(height,20);
  if(animated)body.write('acTL',24,'ascii');
  return body;
}
function expectCode(fn,code){let caught=null;try{fn()}catch(error){caught=error}assert.ok(caught,`expected ${code}`);assert.equal(caught.code,code)}

try{
  const raw={key:`CUSTOM.TEST_${suffix}`,name:'Custom lifecycle icon',usage_scopes:['TOPIC','CATEGORY'],tags:['custom','lifecycle'],image:{mime_type:'image/png',data_base64:pngHeader().toString('base64')}};
  const icon=normalizeCustomImageIconInput(raw);
  assert.equal(icon.source_type,'CUSTOM_IMAGE');assert.equal(icon.color_mode,'ORIGINAL');assert.equal(icon.asset.width,32);assert.equal(icon.asset.height,32);assert.equal(icon.asset.byte_size,24);assert.equal(icon.asset.sha256.length,64);
  expectCode(()=>normalizeCustomImageIconInput({...raw,image:{mime_type:'image/svg+xml',data_base64:Buffer.from('<svg/>').toString('base64')}}),'ICON_IMAGE_TYPE_UNSUPPORTED');
  expectCode(()=>normalizeCustomImageIconInput({...raw,image:{mime_type:'image/png',data_base64:pngHeader(32,32,{animated:true}).toString('base64')}}),'ICON_IMAGE_ANIMATED');
  expectCode(()=>normalizeCustomImageIconInput({...raw,image:{mime_type:'image/png',data_base64:pngHeader(8,8).toString('base64')}}),'ICON_IMAGE_DIMENSIONS_INVALID');

  const inserted=await db.query(`INSERT INTO platform_icons(key,name,source_type,library_pack,library_icon,color_mode,usage_scopes,tags,status)
    VALUES($1,$2,'CUSTOM_IMAGE',NULL,NULL,'ORIGINAL',$3::jsonb,$4::jsonb,'DRAFT') RETURNING id`,[icon.key,icon.name,JSON.stringify(icon.usage_scopes),JSON.stringify(icon.tags)]);
  await db.query(`INSERT INTO platform_icon_assets(icon_id,mime_type,byte_size,width,height,sha256,body) VALUES($1,$2,$3,$4,$5,$6,$7)`,[
    inserted.rows[0].id,icon.asset.mime_type,icon.asset.byte_size,icon.asset.width,icon.asset.height,icon.asset.sha256,icon.asset.body,
  ]);
  let visible=await listPlatformIcons(db,{status:'PUBLISHED',scope:'TOPIC'});
  assert.ok(!visible.some(row=>row.key===icon.key),'draft custom icon must not appear in merchant published catalog');
  await db.query(`UPDATE platform_icons SET status='PUBLISHED',published_at=now() WHERE id=$1`,[inserted.rows[0].id]);
  visible=await listPlatformIcons(db,{status:'PUBLISHED',scope:'TOPIC'});
  const published=visible.find(row=>row.key===icon.key);assert.ok(published);assert.equal(published.source_type,'CUSTOM_IMAGE');assert.equal(published.asset_path,`/v1/icon-assets/${encodeURIComponent(icon.key)}`);assert.equal(published.asset_width,32);assert.equal(published.asset_height,32);
  const asset=await getPlatformIconAsset(db,icon.key);assert.equal(asset.mime_type,'image/png');assert.equal(asset.status,'PUBLISHED');assert.ok(Buffer.from(asset.body).equals(icon.asset.body));

  const draftKey=`CUSTOM.DELETE_${suffix}`;
  const draft=await db.query(`INSERT INTO platform_icons(key,name,source_type,library_pack,library_icon,color_mode,usage_scopes,tags,status)
    VALUES($1,'Delete cascade icon','CUSTOM_IMAGE',NULL,NULL,'ORIGINAL','["ACTION"]'::jsonb,'[]'::jsonb,'DRAFT') RETURNING id`,[draftKey]);
  await db.query(`INSERT INTO platform_icon_assets(icon_id,mime_type,byte_size,width,height,sha256,body) VALUES($1,'image/png',$2,32,32,$3,$4)`,[draft.rows[0].id,icon.asset.byte_size,icon.asset.sha256,icon.asset.body]);
  await db.query('DELETE FROM platform_icons WHERE id=$1',[draft.rows[0].id]);
  const cascaded=await db.query('SELECT count(*)::int AS count FROM platform_icon_assets WHERE icon_id=$1',[draft.rows[0].id]);assert.equal(cascaded.rows[0].count,0,'draft icon deletion must cascade binary asset');
  console.log('PASS Platform Icon Library v1 A2 PostgreSQL lifecycle');
} finally {
  await db.close();
}
