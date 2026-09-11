import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{buildApp}from'../src/app.js';
import{signAccessToken}from'../src/core/tokens.js';

const config=loadConfig(),db=createDatabase(config),suffix=randomUUID().replaceAll('-','').slice(0,12);let app=null,tenantId=null,storeId=null,userId=null,roleId=null,sessionId=null;
try{
 const tenantPublic=`ten_a102_${suffix}`,storePublic=`sto_a102_${suffix}`,slug=`a102-${suffix}`;
 tenantId=(await db.query(`INSERT INTO tenants(public_id,slug,name,status) VALUES($1,$2,'A10.2 lifecycle','ACTIVE') RETURNING id`,[tenantPublic,slug])).rows[0].id;
 await db.query(`INSERT INTO tenant_settings(tenant_id,currency,locale,timezone) VALUES($1,'USD','en','Asia/Phnom_Penh') ON CONFLICT(tenant_id) DO UPDATE SET currency='USD',timezone='Asia/Phnom_Penh'`,[tenantId]);
 storeId=(await db.query(`INSERT INTO stores(public_id,tenant_id,name,status,is_primary) VALUES($1,$2,'Finance Center Store','ACTIVE',true) RETURNING id`,[storePublic,tenantId])).rows[0].id;
 userId=(await db.query(`INSERT INTO merchant_users(public_id,tenant_id,email,password_hash,display_name,status,store_access_mode) VALUES($1,$2,$3,'test-only','Finance Owner','ACTIVE','ALL_STORES') RETURNING id`,[`musr_a102_${suffix}`,tenantId,`a102-${suffix}@example.invalid`])).rows[0].id;
 const existingRole=await db.query(`SELECT id FROM merchant_roles WHERE tenant_id=$1 AND key='OWNER'`,[tenantId]);
 if(existingRole.rowCount)roleId=existingRole.rows[0].id;else roleId=(await db.query(`INSERT INTO merchant_roles(tenant_id,key,name,description,is_system) VALUES($1,'OWNER','Owner','A10.2 lifecycle owner',true) RETURNING id`,[tenantId])).rows[0].id;
 await db.query(`INSERT INTO merchant_role_permissions(role_id,permission_key) SELECT $1,key FROM merchant_permissions ON CONFLICT DO NOTHING`,[roleId]);
 await db.query(`INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[tenantId,userId,roleId]);
 sessionId=randomUUID();await db.query(`INSERT INTO merchant_sessions(id,tenant_id,merchant_user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`,[sessionId,tenantId,userId,Buffer.from(randomUUID()).toString('hex').padEnd(64,'0').slice(0,64)]);
 const signed=await signAccessToken(config,{tenantId,actorType:'MERCHANT',sessionId,subject:userId,permissions:[],roleKeys:[]});
 app=await buildApp(config);const headers={authorization:`Bearer ${signed.token}`,'x-store-id':storePublic};
 const response=await app.inject({method:'GET',url:'/v1/merchant/finance/overview?period=TODAY',headers});
 assert.equal(response.statusCode,200,response.body);const body=response.json().data;
 assert.equal(body.context.store.id,storePublic);assert.equal(body.context.period.key,'TODAY');assert.equal(body.context.period.timezone,'Asia/Phnom_Penh');assert.equal(body.summary.currency,'USD');
 assert.equal(body.summary.cod_driver_custody_count,0);assert.equal(body.summary.cod_awaiting_reconciliation_count,0);assert.equal(body.summary.open_refunds,0);assert.equal(body.summary.net_paid_volume,0);
 assert.deepEqual(body.reconciliation.cod,[]);assert.deepEqual(body.reconciliation.refunds,[]);assert.ok(Array.isArray(body.payment_methods));assert.ok(Array.isArray(body.recent_activity));
 assert.equal(body.capabilities.provider_settlement_ledger,false);assert.equal(body.capabilities.provider_fee_ledger,false);assert.equal(body.capabilities.manual_finance_adjustments,false);assert.equal(body.capabilities.csv_export,false);
 assert.ok(!('tenant_id'in body.context));assert.ok(!('store_id'in body.context));
 const period7=await app.inject({method:'GET',url:'/v1/merchant/finance/overview?period=7D',headers});assert.equal(period7.statusCode,200,period7.body);assert.equal(period7.json().data.context.period.days,7);
 const invalid=await app.inject({method:'GET',url:'/v1/merchant/finance/overview?period=365D',headers});assert.equal(invalid.statusCode,400,'period values must be bounded');
 await db.query(`DELETE FROM merchant_role_permissions WHERE role_id=$1 AND permission_key='finance.read'`,[roleId]);
 const denied=await app.inject({method:'GET',url:'/v1/merchant/finance/overview?period=TODAY',headers});assert.equal(denied.statusCode,403,'finance.read must be required');
 console.log('PASS Finance & Reconciliation Center v1 A10.2 PostgreSQL lifecycle');
}finally{
 if(app)await app.close().catch(()=>{});
 if(tenantId)await db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
 await db.close();
}
