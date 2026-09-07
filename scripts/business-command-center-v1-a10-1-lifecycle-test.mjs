import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{buildApp}from'../src/app.js';
import{signAccessToken}from'../src/core/tokens.js';

const config=loadConfig(),db=createDatabase(config),suffix=randomUUID().replaceAll('-','').slice(0,12);let app=null,tenantId=null,storeId=null,userId=null,roleId=null,sessionId=null;
try{
 const tenantPublic=`ten_a101_${suffix}`,storePublic=`sto_a101_${suffix}`,slug=`a101-${suffix}`;
 const tenant=await db.query(`INSERT INTO tenants(public_id,slug,name,status) VALUES($1,$2,'A10.1 lifecycle','ACTIVE') RETURNING id`,[tenantPublic,slug]);tenantId=tenant.rows[0].id;
 await db.query(`INSERT INTO tenant_settings(tenant_id,currency,locale,timezone) VALUES($1,'USD','en','Asia/Phnom_Penh') ON CONFLICT(tenant_id) DO UPDATE SET currency='USD',timezone='Asia/Phnom_Penh'`,[tenantId]);
 const store=await db.query(`INSERT INTO stores(public_id,tenant_id,name,status,is_primary) VALUES($1,$2,'Command Center Store','ACTIVE',true) RETURNING id`,[storePublic,tenantId]);storeId=store.rows[0].id;
 const user=await db.query(`INSERT INTO merchant_users(public_id,tenant_id,email,password_hash,display_name,status,store_access_mode) VALUES($1,$2,$3,'test-only','A10 Owner','ACTIVE','ALL_STORES') RETURNING id`,[`musr_a101_${suffix}`,tenantId,`a101-${suffix}@example.invalid`]);userId=user.rows[0].id;
 const existingRole=await db.query(`SELECT id FROM merchant_roles WHERE tenant_id=$1 AND key='OWNER'`,[tenantId]);
 if(existingRole.rowCount)roleId=existingRole.rows[0].id;else roleId=(await db.query(`INSERT INTO merchant_roles(tenant_id,key,name,description,is_system) VALUES($1,'OWNER','Owner','A10 lifecycle owner',true) RETURNING id`,[tenantId])).rows[0].id;
 await db.query(`INSERT INTO merchant_role_permissions(role_id,permission_key) SELECT $1,key FROM merchant_permissions ON CONFLICT DO NOTHING`,[roleId]);
 await db.query(`INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[tenantId,userId,roleId]);
 sessionId=randomUUID();await db.query(`INSERT INTO merchant_sessions(id,tenant_id,merchant_user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`,[sessionId,tenantId,userId,Buffer.from(randomUUID()).toString('hex').padEnd(64,'0').slice(0,64)]);
 const signed=await signAccessToken(config,{tenantId,actorType:'MERCHANT',sessionId,subject:userId,permissions:[],roleKeys:[]});
 app=await buildApp(config);
 const headers={authorization:`Bearer ${signed.token}`,'x-store-id':storePublic};
 const response=await app.inject({method:'GET',url:'/v1/merchant/business-dashboard?period=TODAY',headers});
 assert.equal(response.statusCode,200,response.body);const body=response.json().data;
 assert.equal(body.context.store.id,storePublic);assert.equal(body.context.period.key,'TODAY');assert.equal(body.context.period.timezone,'Asia/Phnom_Penh');assert.equal(body.context.period.currency,'USD');assert.ok(!('tenant_id'in body.context),'internal tenant id must not be returned');
 for(const section of ['orders','payments','inventory','delivery','kitchen','staff','customers','loyalty','catalog','promotions'])assert.ok(body.available[section],`${section} permission should be available`);
 for(const section of ['orders','payments','inventory','delivery','kitchen','staff','customers','loyalty','catalog','promotions'])assert.ok(body.sections[section],`${section} query must execute against PostgreSQL`);
 assert.equal(body.sections.orders.summary.open,0);assert.equal(body.sections.payments.summary.failed,0);assert.equal(body.sections.delivery.summary.cod_reconciliation_amount,0);assert.equal(body.sections.kitchen.summary.waiting,0);assert.equal(body.sections.inventory.summary.low_stock,0);
 await db.query(`DELETE FROM merchant_role_permissions WHERE role_id=$1 AND permission_key='kitchen.read'`,[roleId]);
 const restricted=await app.inject({method:'GET',url:'/v1/merchant/business-dashboard?period=7D',headers});assert.equal(restricted.statusCode,200,restricted.body);const restrictedBody=restricted.json().data;
 assert.equal(restrictedBody.available.kitchen,false);assert.ok(!('kitchen'in restrictedBody.sections),'kitchen section must be omitted without kitchen.read');assert.ok(restrictedBody.sections.delivery,'delivery section remains independently available');
 const invalid=await app.inject({method:'GET',url:'/v1/merchant/business-dashboard?period=365D',headers});assert.equal(invalid.statusCode,400,'period values must be bounded');
 console.log('PASS Business Command Center v1 A10.1 PostgreSQL lifecycle');
}finally{
 if(app)await app.close().catch(()=>{});
 if(tenantId)await db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
 await db.close();
}
