import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{validateCustomerNavigationIconPolicy}from'../src/modules/themes/customer-icon-policy.js';

const db=createDatabase(loadConfig());
const suffix=randomUUID().replaceAll('-','').slice(0,10).toUpperCase();
const key=`CUSTOM.NAV_${suffix}`,token=`platform:${key}`;
async function expectCode(fn,code){let caught=null;try{await fn()}catch(error){caught=error}assert.ok(caught,`expected ${code}`);assert.equal(caught.code,code)}
try{
 const inserted=await db.query(`INSERT INTO platform_icons(key,name,source_type,library_pack,library_icon,color_mode,usage_scopes,tags,status)
   VALUES($1,'Navigation lifecycle','CUSTOM_IMAGE',NULL,NULL,'ORIGINAL','["NAVIGATION"]'::jsonb,'[]'::jsonb,'DRAFT') RETURNING id`,[key]);
 const iconId=inserted.rows[0].id,body=Buffer.from([137,80,78,71,13,10,26,10]);
 await db.query(`INSERT INTO platform_icon_assets(icon_id,variant,mime_type,byte_size,width,height,sha256,body)
   VALUES($1,'DEFAULT','image/png',$2,48,48,$3,$4)`,[iconId,body.length,'a'.repeat(64),body]);
 await expectCode(()=>validateCustomerNavigationIconPolicy(db,{nav_home_icon:token},{strict:true}),'THEME_NAV_ICON_PLATFORM_NOT_ALLOWED');
 await db.query(`UPDATE platform_icons SET status='PUBLISHED',published_at=now() WHERE id=$1`,[iconId]);
 const accepted=await validateCustomerNavigationIconPolicy(db,{nav_home_icon:token},{strict:true});
 assert.deepEqual(accepted,[key]);
 await db.query(`UPDATE platform_icons SET usage_scopes='["TOPIC"]'::jsonb WHERE id=$1`,[iconId]);
 await expectCode(()=>validateCustomerNavigationIconPolicy(db,{nav_home_icon:token},{strict:true}),'THEME_NAV_ICON_PLATFORM_NOT_ALLOWED');
 await db.query(`UPDATE platform_icons SET usage_scopes='["NAVIGATION"]'::jsonb,status='RETIRED',retired_at=now() WHERE id=$1`,[iconId]);
 await expectCode(()=>validateCustomerNavigationIconPolicy(db,{nav_home_icon:token},{strict:true}),'THEME_NAV_ICON_PLATFORM_NOT_ALLOWED');
 console.log('PASS Platform custom navigation icon A8.1 PostgreSQL lifecycle');
}finally{
 await db.query('DELETE FROM platform_icons WHERE key=$1',[key]).catch(()=>{});
 await db.close();
}
