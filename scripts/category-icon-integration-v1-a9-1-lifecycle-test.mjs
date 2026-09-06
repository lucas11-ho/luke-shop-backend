import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{validatePlatformIconReference}from'../src/modules/icons/reference-policy.js';

const db=createDatabase(loadConfig());
const suffix=randomUUID().replaceAll('-','').slice(0,10).toUpperCase();
const key=`CUSTOM.CATEGORY_${suffix}`;
async function expectCode(fn,code){let caught=null;try{await fn()}catch(error){caught=error}assert.ok(caught,`expected ${code}`);assert.equal(caught.code,code)}
try{
 const column=await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='categories' AND column_name='icon_key'`);
 assert.equal(column.rowCount,1,'migration 040 must add categories.icon_key');
 const fk=await db.query(`SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='categories' AND c.conname='categories_icon_key_fkey' AND c.contype='f'`);
 assert.equal(fk.rowCount,1,'migration 040 must install category icon foreign key');
 const inserted=await db.query(`INSERT INTO platform_icons(key,name,source_type,library_pack,library_icon,color_mode,usage_scopes,tags,status)
   VALUES($1,'Category lifecycle','CUSTOM_IMAGE',NULL,NULL,'ORIGINAL','["CATEGORY"]'::jsonb,'[]'::jsonb,'DRAFT') RETURNING id`,[key]);
 const iconId=inserted.rows[0].id,body=Buffer.from([137,80,78,71,13,10,26,10]);
 await db.query(`INSERT INTO platform_icon_assets(icon_id,variant,mime_type,byte_size,width,height,sha256,body)
   VALUES($1,'DEFAULT','image/png',$2,48,48,$3,$4)`,[iconId,body.length,'b'.repeat(64),body]);
 await expectCode(()=>validatePlatformIconReference(db,key,{scope:'CATEGORY',errorCode:'CATEGORY_ICON_NOT_ALLOWED'}),'CATEGORY_ICON_NOT_ALLOWED');
 await db.query(`UPDATE platform_icons SET status='PUBLISHED',published_at=now() WHERE id=$1`,[iconId]);
 assert.equal(await validatePlatformIconReference(db,key,{scope:'CATEGORY',errorCode:'CATEGORY_ICON_NOT_ALLOWED'}),key);
 await db.query(`UPDATE platform_icons SET usage_scopes='["TOPIC"]'::jsonb WHERE id=$1`,[iconId]);
 await expectCode(()=>validatePlatformIconReference(db,key,{scope:'CATEGORY',errorCode:'CATEGORY_ICON_NOT_ALLOWED'}),'CATEGORY_ICON_NOT_ALLOWED');
 await db.query(`UPDATE platform_icons SET usage_scopes='["CATEGORY"]'::jsonb,status='RETIRED',retired_at=now() WHERE id=$1`,[iconId]);
 await expectCode(()=>validatePlatformIconReference(db,key,{scope:'CATEGORY',errorCode:'CATEGORY_ICON_NOT_ALLOWED'}),'CATEGORY_ICON_NOT_ALLOWED');
 console.log('PASS Category Icon Integration v1 A9.1 PostgreSQL lifecycle');
}finally{
 await db.query('DELETE FROM platform_icons WHERE key=$1',[key]).catch(()=>{});
 await db.close();
}
