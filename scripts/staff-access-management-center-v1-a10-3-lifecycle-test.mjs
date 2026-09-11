import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{buildApp}from'../src/app.js';
import{signAccessToken}from'../src/core/tokens.js';

const config=loadConfig(),db=createDatabase(config),suffix=randomUUID().replaceAll('-','').slice(0,12);let app=null,tenantId=null,otherTenantId=null,ownerRoleId=null,ownerId=null,sessionId=null;
const hash=()=>Buffer.from(randomUUID()).toString('hex').padEnd(64,'0').slice(0,64);
try{
 tenantId=(await db.query(`INSERT INTO tenants(public_id,slug,name,status) VALUES($1,$2,'A10.3 lifecycle','ACTIVE') RETURNING id`,[`ten_a103_${suffix}`,`a103-${suffix}`])).rows[0].id;
 otherTenantId=(await db.query(`INSERT INTO tenants(public_id,slug,name,status) VALUES($1,$2,'A10.3 other tenant','ACTIVE') RETURNING id`,[`ten_a103b_${suffix}`,`a103b-${suffix}`])).rows[0].id;
 await db.query(`INSERT INTO tenant_settings(tenant_id,currency,locale,timezone) VALUES($1,'USD','en','UTC') ON CONFLICT(tenant_id) DO NOTHING`,[tenantId]);
 const storeA=(await db.query(`INSERT INTO stores(public_id,tenant_id,name,status,is_primary) VALUES($1,$2,'A10.3 Primary','ACTIVE',true) RETURNING id`,[`sto_a103_${suffix}`,tenantId])).rows[0].id;
 await db.query(`INSERT INTO stores(public_id,tenant_id,name,status,is_primary) VALUES($1,$2,'A10.3 Secondary','ACTIVE',false)`,[`sto_a103x_${suffix}`,tenantId]);
 await db.query(`INSERT INTO stores(public_id,tenant_id,name,status,is_primary) VALUES($1,$2,'Other Store','ACTIVE',true)`,[`sto_a103b_${suffix}`,otherTenantId]);

 ownerId=(await db.query(`INSERT INTO merchant_users(public_id,tenant_id,email,password_hash,display_name,status,store_access_mode) VALUES($1,$2,$3,'test-only','Access Owner','ACTIVE','ALL_STORES') RETURNING id`,[`musr_a103_owner_${suffix}`,tenantId,`a103-owner-${suffix}@example.invalid`])).rows[0].id;
 const scopedId=(await db.query(`INSERT INTO merchant_users(public_id,tenant_id,email,password_hash,display_name,status,store_access_mode) VALUES($1,$2,$3,'test-only','Scoped Cashier','ACTIVE','ASSIGNED_STORES') RETURNING id`,[`musr_a103_scoped_${suffix}`,tenantId,`a103-scoped-${suffix}@example.invalid`])).rows[0].id;
 const suspendedId=(await db.query(`INSERT INTO merchant_users(public_id,tenant_id,email,password_hash,display_name,status,store_access_mode) VALUES($1,$2,$3,'test-only','Suspended Kitchen','SUSPENDED','ALL_STORES') RETURNING id`,[`musr_a103_suspended_${suffix}`,tenantId,`a103-suspended-${suffix}@example.invalid`])).rows[0].id;
 await db.query(`INSERT INTO merchant_users(public_id,tenant_id,email,password_hash,display_name,status,store_access_mode) VALUES($1,$2,$3,'test-only','Other Tenant Staff','ACTIVE','ALL_STORES')`,[`musr_a103_other_${suffix}`,otherTenantId,`a103-other-${suffix}@example.invalid`]);

 const existingOwner=await db.query(`SELECT id FROM merchant_roles WHERE tenant_id=$1 AND key='OWNER'`,[tenantId]);
 ownerRoleId=existingOwner.rows[0]?.id||(await db.query(`INSERT INTO merchant_roles(tenant_id,key,name,description,is_system) VALUES($1,'OWNER','Owner','Protected owner',true) RETURNING id`,[tenantId])).rows[0].id;
 await db.query(`INSERT INTO merchant_role_permissions(role_id,permission_key) SELECT $1,key FROM merchant_permissions ON CONFLICT DO NOTHING`,[ownerRoleId]);
 await db.query(`INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[tenantId,ownerId,ownerRoleId]);
 const cashierRole=(await db.query(`SELECT id FROM merchant_roles WHERE tenant_id=$1 AND key='CASHIER'`,[tenantId])).rows[0].id;
 const kitchenRole=(await db.query(`SELECT id FROM merchant_roles WHERE tenant_id=$1 AND key='KITCHEN'`,[tenantId])).rows[0].id;
 await db.query(`INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3),($1,$4,$5) ON CONFLICT DO NOTHING`,[tenantId,scopedId,cashierRole,suspendedId,kitchenRole]);
 await db.query(`INSERT INTO merchant_user_store_access(tenant_id,merchant_user_id,store_id,created_by) VALUES($1,$2,$3,$4)`,[tenantId,scopedId,storeA,ownerId]);

 sessionId=randomUUID();
 await db.query(`INSERT INTO merchant_sessions(id,tenant_id,merchant_user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`,[sessionId,tenantId,ownerId,hash()]);
 await db.query(`INSERT INTO merchant_sessions(id,tenant_id,merchant_user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`,[randomUUID(),tenantId,suspendedId,hash()]);
 await db.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,'MERCHANT',$2,'merchant.staff.store_access.update','merchant_user',$3,'{}'::jsonb)`,[tenantId,ownerId,scopedId]);

 const signed=await signAccessToken(config,{tenantId,actorType:'MERCHANT',sessionId,subject:ownerId,permissions:[],roleKeys:[]});
 app=await buildApp(config);const headers={authorization:`Bearer ${signed.token}`};
 let response=await app.inject({method:'GET',url:'/v1/merchant/access/overview',headers});
 assert.equal(response.statusCode,200,response.body);let body=response.json().data;
 assert.equal(body.summary.total_staff,3,'must remain tenant scoped');
 assert.equal(body.summary.active_staff,2);assert.equal(body.summary.suspended_staff,1);assert.equal(body.summary.disabled_staff,0);
 assert.equal(body.summary.assigned_store_scope_staff,1);assert.equal(body.summary.all_store_scope_staff,2);assert.equal(body.summary.active_sessions,2);
 assert.equal(body.summary.active_owners,1);assert.equal(body.attention.active_without_roles,0);assert.equal(body.attention.inactive_with_active_sessions,1);
 assert.equal(body.capabilities.staff_manage,true);assert.equal(body.capabilities.roles_read,true);assert.equal(body.capabilities.audit_read,true);assert.equal(body.capabilities.store_scope_manage,true);
 assert.ok(body.roles.total_roles>=5);assert.equal(body.roles.operational_roles.length,4);assert.deepEqual(body.roles.operational_roles.map(r=>r.key),['DRIVER','KITCHEN','CASHIER','DISPATCHER']);
 assert.ok(body.roles.operational_roles.every(r=>r.is_system===true));
 assert.equal(body.recent_access_activity[0].action,'merchant.staff.store_access.update');
 const serialized=JSON.stringify(body);for(const forbidden of ['password_hash','refresh_token_hash','request_ip','request_id'])assert.ok(!serialized.includes(forbidden),`must not leak ${forbidden}`);

 await db.query(`DELETE FROM merchant_role_permissions WHERE role_id=$1 AND permission_key='audit.read'`,[ownerRoleId]);
 response=await app.inject({method:'GET',url:'/v1/merchant/access/overview',headers});assert.equal(response.statusCode,200,response.body);body=response.json().data;
 assert.equal(body.capabilities.audit_read,false);assert.equal(body.recent_access_activity,null,'audit activity must fail closed without audit.read');

 await db.query(`DELETE FROM merchant_role_permissions WHERE role_id=$1 AND permission_key='merchant.roles.read'`,[ownerRoleId]);
 response=await app.inject({method:'GET',url:'/v1/merchant/access/overview',headers});assert.equal(response.statusCode,200,response.body);body=response.json().data;
 assert.equal(body.capabilities.roles_read,false);assert.equal(body.roles,null,'role catalog summary must fail closed without roles.read');

 await db.query(`DELETE FROM merchant_role_permissions WHERE role_id=$1 AND permission_key='merchant.staff.read'`,[ownerRoleId]);
 response=await app.inject({method:'GET',url:'/v1/merchant/access/overview',headers});assert.equal(response.statusCode,403,'merchant.staff.read must gate the management overview');
 console.log('PASS Staff & Access Management Center v1 A10.3 PostgreSQL lifecycle');
}finally{
 if(app)await app.close().catch(()=>{});
 if(otherTenantId)await db.query('DELETE FROM tenants WHERE id=$1',[otherTenantId]).catch(()=>{});
 if(tenantId)await db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
 await db.close();
}
