import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{validatePlatformIconReference}from'../src/modules/icons/reference-policy.js';

const db=createDatabase(loadConfig());
const suffix=randomUUID().replaceAll('-','').slice(0,10).toUpperCase();
const key=`CUSTOM.MENU_${suffix}`;
const tenantPublic=`ten_a92_${suffix.toLowerCase()}`,storePublic=`sto_a92_${suffix.toLowerCase()}`,menuPublic=`menu_a92_${suffix.toLowerCase()}`;
async function expectCode(fn,code){let caught=null;try{await fn()}catch(error){caught=error}assert.ok(caught,`expected ${code}`);assert.equal(caught.code,code)}
try{
 const table=await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='storefront_menu_shortcuts'`);
 assert.equal(table.rowCount,1,'migration 041 must add storefront_menu_shortcuts');
 const tenant=await db.query(`INSERT INTO tenants(public_id,slug,name,status) VALUES($1,$2,'A9.2 lifecycle','ACTIVE') RETURNING id`,[tenantPublic,`a92-${suffix.toLowerCase()}`]);
 const store=await db.query(`INSERT INTO stores(public_id,tenant_id,name,status,is_primary) VALUES($1,$2,'Primary','ACTIVE',true) RETURNING id`,[storePublic,tenant.rows[0].id]);
 const inserted=await db.query(`INSERT INTO platform_icons(key,name,source_type,library_pack,library_icon,color_mode,usage_scopes,tags,status)
   VALUES($1,'Menu lifecycle','CUSTOM_IMAGE',NULL,NULL,'ORIGINAL','["MENU"]'::jsonb,'[]'::jsonb,'DRAFT') RETURNING id`,[key]);
 const iconId=inserted.rows[0].id,body=Buffer.from([137,80,78,71,13,10,26,10]);
 await db.query(`INSERT INTO platform_icon_assets(icon_id,variant,mime_type,byte_size,width,height,sha256,body)
   VALUES($1,'DEFAULT','image/png',$2,48,48,$3,$4)`,[iconId,body.length,'c'.repeat(64),body]);
 await expectCode(()=>validatePlatformIconReference(db,key,{scope:'MENU',errorCode:'MENU_ICON_NOT_ALLOWED'}),'MENU_ICON_NOT_ALLOWED');
 await db.query(`UPDATE platform_icons SET status='PUBLISHED',published_at=now() WHERE id=$1`,[iconId]);
 assert.equal(await validatePlatformIconReference(db,key,{scope:'MENU',errorCode:'MENU_ICON_NOT_ALLOWED'}),key);
 await db.query(`INSERT INTO storefront_menu_shortcuts(public_id,tenant_id,store_id,title,destination,icon_key,status,sort_order)
   VALUES($1,$2,$3,'Promotions','EXPLORE',$4,'ACTIVE',10)`,[menuPublic,tenant.rows[0].id,store.rows[0].id,key]);
 const assigned=await db.query(`SELECT destination,icon_key,status FROM storefront_menu_shortcuts WHERE public_id=$1`,[menuPublic]);
 assert.deepEqual(assigned.rows[0],{destination:'EXPLORE',icon_key:key,status:'ACTIVE'},'published MENU icon can be assigned to a bounded shortcut');
 await db.query(`UPDATE platform_icons SET usage_scopes='["TOPIC"]'::jsonb WHERE id=$1`,[iconId]);
 await expectCode(()=>validatePlatformIconReference(db,key,{scope:'MENU',errorCode:'MENU_ICON_NOT_ALLOWED'}),'MENU_ICON_NOT_ALLOWED');
 const historical=await db.query(`SELECT icon_key FROM storefront_menu_shortcuts WHERE public_id=$1`,[menuPublic]);
 assert.equal(historical.rows[0].icon_key,key,'scope removal does not rewrite an existing shortcut reference');
 await db.query(`UPDATE platform_icons SET usage_scopes='["MENU"]'::jsonb,status='RETIRED',retired_at=now() WHERE id=$1`,[iconId]);
 await expectCode(()=>validatePlatformIconReference(db,key,{scope:'MENU',errorCode:'MENU_ICON_NOT_ALLOWED'}),'MENU_ICON_NOT_ALLOWED');
 const retired=await db.query(`SELECT s.icon_key,i.status FROM storefront_menu_shortcuts s LEFT JOIN platform_icons i ON i.key=s.icon_key WHERE s.public_id=$1`,[menuPublic]);
 assert.deepEqual(retired.rows[0],{icon_key:key,status:'RETIRED'},'retired icon remains renderable for an existing shortcut while blocked for new selection');
 console.log('PASS Menu Icon Integration v1 A9.2 PostgreSQL lifecycle');
}finally{
 await db.query('DELETE FROM storefront_menu_shortcuts WHERE public_id=$1',[menuPublic]).catch(()=>{});
 await db.query('DELETE FROM stores WHERE public_id=$1',[storePublic]).catch(()=>{});
 await db.query('DELETE FROM tenants WHERE public_id=$1',[tenantPublic]).catch(()=>{});
 await db.query('DELETE FROM platform_icons WHERE key=$1',[key]).catch(()=>{});
 await db.close();
}
