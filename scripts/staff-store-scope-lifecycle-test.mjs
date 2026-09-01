import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{buildApp}from'../src/app.js';
import{loadConfig}from'../src/config.js';
import{hashPassword}from'../src/core/passwords.js';
import{ALL_PERMISSIONS}from'../src/core/permissions.js';

const config=loadConfig(),app=await buildApp(config),suffix=randomUUID().replaceAll('-','').slice(0,12),password='Staff-Store-Scope-Lifecycle-2026!';
let tenantId,otherTenantId;
const json=r=>{try{return r.json()}catch{return null}},expect=(r,status,label)=>{assert.equal(r.statusCode,status,`${label}: ${r.statusCode} ${r.body}`);return json(r)},req=o=>app.inject(o);
try{
 await app.ready();const db=app.db,passwordHash=await hashPassword(password);
 tenantId=randomUUID();otherTenantId=randomUUID();
 const ownerId=randomUUID(),workerId=randomUUID(),ownerRoleId=randomUUID(),workerRoleId=randomUUID();
 const storeAId=randomUUID(),storeBId=randomUUID(),otherStoreId=randomUUID();
 const storeA=`str_scope_a_${suffix}`,storeB=`str_scope_b_${suffix}`,otherStore=`str_scope_other_${suffix}`;
 const slug=`scope-${suffix}`,otherSlug=`scope-other-${suffix}`,ownerEmail=`owner-${suffix}@example.com`,workerEmail=`worker-${suffix}@example.com`;
 await db.transaction(async client=>{
  await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[tenantId,`tnt_scope_${suffix}`,slug,`Scope ${suffix}`]);
  await client.query('INSERT INTO tenant_settings(tenant_id) VALUES($1)',[tenantId]);
  await client.query("INSERT INTO stores(id,public_id,tenant_id,slug,name,status,is_primary) VALUES($1,$2,$3,$4,'Store A','ACTIVE',false),($5,$6,$3,$7,'Store B','ACTIVE',true)",[storeAId,storeA,tenantId,`scope-a-${suffix}`,storeBId,storeB,`scope-b-${suffix}`]);
  await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status,password_changed_at) VALUES($1,$2,$3,$4,$5,'Owner','ACTIVE',now()),($6,$7,$3,$8,$5,'Worker','ACTIVE',now())",[ownerId,`musr_scope_owner_${suffix}`,tenantId,ownerEmail,passwordHash,workerId,`musr_scope_worker_${suffix}`,workerEmail]);
  await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true),($3,$2,'SCOPE_WORKER','Scope Worker',false)",[ownerRoleId,tenantId,workerRoleId]);
  for(const permission of ALL_PERMISSIONS)await client.query('INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,$2)',[ownerRoleId,permission]);
  await client.query("INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,'delivery.read')",[workerRoleId]);
  await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3),($1,$4,$5)',[tenantId,ownerId,ownerRoleId,workerId,workerRoleId]);
  await client.query("INSERT INTO delivery_methods(id,public_id,tenant_id,store_id,code,name,fulfillment_mode,status) VALUES($1,$2,$3,$4,'STORE_A','Store A Delivery','LOCAL_DELIVERY','ACTIVE'),($5,$6,$3,$7,'STORE_B','Store B Delivery','LOCAL_DELIVERY','ACTIVE')",[randomUUID(),`dlv_scope_a_${suffix}`,tenantId,storeAId,randomUUID(),`dlv_scope_b_${suffix}`,storeBId]);
  await client.query("INSERT INTO delivery_drivers(id,public_id,tenant_id,store_id,merchant_user_id,display_name,status,vehicle_type) VALUES($1,$2,$3,$4,$5,'Worker Driver','ACTIVE','MOTORBIKE')",[randomUUID(),`drv_scope_b_${suffix}`,tenantId,storeBId,workerId]);
  await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[otherTenantId,`tnt_scope_other_${suffix}`,otherSlug,`Other ${suffix}`]);
  await client.query('INSERT INTO tenant_settings(tenant_id) VALUES($1)',[otherTenantId]);
  await client.query("INSERT INTO stores(id,public_id,tenant_id,slug,name,status,is_primary) VALUES($1,$2,$3,$4,'Other Store','ACTIVE',true)",[otherStoreId,otherStore,otherTenantId,`other-store-${suffix}`]);
 });
 const tenantHeaders={'x-tenant-slug':slug};
 const ownerLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:ownerEmail,password}}),200,'owner login');
 assert.equal(ownerLogin.data.user.store_scope.mode,'ALL_STORES');assert.equal(ownerLogin.data.user.store_scope.stores.length,2);
 const ownerAuth={authorization:`Bearer ${ownerLogin.data.tokens.access_token}`};
 expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...ownerAuth,'x-store-id':storeA}}),200,'owner Store A');
 expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...ownerAuth,'x-store-id':storeB}}),200,'owner Store B');
 const ownerNarrow=expect(await req({method:'PUT',url:`/v1/merchant/staff/${ownerLogin.data.user.id}/store-access`,headers:ownerAuth,payload:{mode:'ASSIGNED_STORES',store_ids:[storeA]}}),409,'owner cannot be narrowed');
 assert.equal(ownerNarrow.error.code,'OWNER_STORE_SCOPE_PROTECTED');

 const workerLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:workerEmail,password}}),200,'legacy worker login');
 assert.equal(workerLogin.data.user.store_scope.mode,'ALL_STORES');
 const workerAuth={authorization:`Bearer ${workerLogin.data.tokens.access_token}`};
 expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...workerAuth,'x-store-id':storeA}}),200,'legacy worker Store A');
 expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...workerAuth,'x-store-id':storeB}}),200,'legacy worker Store B');

 const narrowed=expect(await req({method:'PUT',url:`/v1/merchant/staff/musr_scope_worker_${suffix}/store-access`,headers:ownerAuth,payload:{mode:'ASSIGNED_STORES',store_ids:[storeA]}}),200,'assign worker Store A').data.staff.store_scope;
 assert.equal(narrowed.mode,'ASSIGNED_STORES');assert.deepEqual(narrowed.stores.map(s=>s.id),[storeA]);
 const sameTokenA=expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...workerAuth,'x-store-id':storeA}}),200,'same token Store A allowed');
 assert.deepEqual(sameTokenA.data.delivery_methods.map(m=>m.code),['STORE_A']);
 const sameTokenB=expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...workerAuth,'x-store-id':storeB}}),403,'same token Store B denied');
 assert.equal(sameTokenB.error.code,'STAFF_STORE_ACCESS_REQUIRED');
 const crossTenant=expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...workerAuth,'x-store-id':otherStore}}),403,'cross tenant store denied');
 assert.equal(crossTenant.error.code,'STAFF_STORE_ACCESS_REQUIRED');
 const implicit=expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:workerAuth}),200,'assigned store injected instead of tenant primary');
 assert.deepEqual(implicit.data.delivery_methods.map(m=>m.code),['STORE_A']);
 const permissionStillApplies=expect(await req({method:'POST',url:'/v1/merchant/delivery-methods',headers:{...workerAuth,'x-store-id':storeA},payload:{code:'NOPE',name:'Nope',fulfillment_mode:'PICKUP'}}),403,'permission still required');
 assert.equal(permissionStillApplies.error.code,'PERMISSION_REQUIRED');
 const driverBlocked=expect(await req({method:'GET',url:'/v1/driver/me',headers:{...workerAuth,'x-store-id':storeB}}),403,'driver cannot force linked unassigned store');
 assert.equal(driverBlocked.error.code,'STAFF_STORE_ACCESS_REQUIRED');
 const driverAssignedContext=expect(await req({method:'GET',url:'/v1/driver/me',headers:workerAuth}),403,'driver linkage remains store-specific');
 assert.equal(driverAssignedContext.error.code,'DRIVER_PROFILE_REQUIRED');

 const me=expect(await req({method:'GET',url:'/v1/merchant/me',headers:workerAuth}),200,'me reflects fresh assigned scope').data.user;
 assert.equal(me.store_scope.mode,'ASSIGNED_STORES');assert.deepEqual(me.store_scope.stores.map(s=>s.id),[storeA]);
 const switched=expect(await req({method:'PUT',url:`/v1/merchant/staff/musr_scope_worker_${suffix}/store-access`,headers:ownerAuth,payload:{mode:'ASSIGNED_STORES',store_ids:[storeB]}}),200,'switch worker to Store B').data.staff.store_scope;
 assert.deepEqual(switched.stores.map(s=>s.id),[storeB]);
 const oldA=expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...workerAuth,'x-store-id':storeA}}),403,'old assignment revoked immediately');assert.equal(oldA.error.code,'STAFF_STORE_ACCESS_REQUIRED');
 const newB=expect(await req({method:'GET',url:'/v1/merchant/delivery-methods',headers:{...workerAuth,'x-store-id':storeB}}),200,'new assignment active immediately');assert.deepEqual(newB.data.delivery_methods.map(m=>m.code),['STORE_B']);
 const audit=await db.query("SELECT metadata FROM audit_logs WHERE tenant_id=$1 AND action='merchant.staff.store_access.update' AND target_id=$2 ORDER BY created_at",[tenantId,workerId]);
 assert.equal(audit.rowCount,2);assert.equal(audit.rows[1].metadata.to_mode,'ASSIGNED_STORES');
 console.log('PASS OWNER and legacy ALL_STORES compatibility');
 console.log('PASS assigned Store A succeeds while Store B and cross-tenant store are denied server-side');
 console.log('PASS no-header requests cannot fall back to an unassigned primary store');
 console.log('PASS permission checks remain additive to store scope');
 console.log('PASS store-assignment changes are audited and apply to an already-issued token');
 console.log('PASS Driver context cannot force an unassigned linked-driver store');
}finally{
 if(tenantId)await app.db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
 if(otherTenantId)await app.db.query('DELETE FROM tenants WHERE id=$1',[otherTenantId]).catch(()=>{});
 await app.close().catch(()=>{});
}
