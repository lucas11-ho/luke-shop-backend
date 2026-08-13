import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/core/passwords.js';
import { ALL_PERMISSIONS } from '../src/core/permissions.js';

const config=loadConfig(); const app=await buildApp(config); const suffix=randomUUID().replaceAll('-','').slice(0,12);
const slug=`staff-${suffix}`; const ownerEmail=`owner-${suffix}@example.com`; const otherTenantEmail=`other-${suffix}@example.com`;
const password='Staff-RBAC-Lifecycle-Password-2026!'; const resetPassword='Staff-RBAC-Reset-Password-2026!'; let tenantId; let otherTenantId;
const j=(r)=>{try{return r.json();}catch{return null;}}; const expect=(r,s,label)=>{assert.equal(r.statusCode,s,`${label}: ${r.statusCode} ${r.body}`);return j(r);}; const req=(o)=>app.inject(o);
try{
  await app.ready(); const db=app.db; const passwordHash=await hashPassword(password); tenantId=randomUUID(); otherTenantId=randomUUID(); const ownerId=randomUUID(); const ownerRoleId=randomUUID();
  await db.transaction(async(client)=>{
    await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[tenantId,`tnt_staff_${suffix}`,slug,`Staff Test ${suffix}`]);
    await client.query("INSERT INTO tenant_settings(tenant_id) VALUES($1)",[tenantId]);
    await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status,password_changed_at) VALUES($1,$2,$3,$4,$5,'Owner','ACTIVE',now())",[ownerId,`musr_owner_${suffix}`,tenantId,ownerEmail,passwordHash]);
    await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true)",[ownerRoleId,tenantId]);
    for(const permission of ALL_PERMISSIONS) await client.query('INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,$2)',[ownerRoleId,permission]);
    await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)',[tenantId,ownerId,ownerRoleId]);
    await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[otherTenantId,`tnt_other_${suffix}`,`other-${suffix}`,`Other ${suffix}`]);
    await client.query("INSERT INTO tenant_settings(tenant_id) VALUES($1)",[otherTenantId]);
    await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status) VALUES($1,$2,$3,$4,$5,'Other Owner','ACTIVE')",[randomUUID(),`musr_other_${suffix}`,otherTenantId,otherTenantEmail,passwordHash]);
  });
  const tenantHeaders={'x-tenant-slug':slug};
  const login=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:ownerEmail,password}}),200,'owner login');
  const ownerAuth={authorization:`Bearer ${login.data.tokens.access_token}`};
  const permissions=expect(await req({method:'GET',url:'/v1/merchant/permissions',headers:ownerAuth}),200,'permissions').data.permissions;
  assert.ok(permissions.some((p)=>p.key==='merchant.staff.manage'));
  const roles=expect(await req({method:'GET',url:'/v1/merchant/roles',headers:ownerAuth}),200,'roles').data.roles;
  const ownerRole=roles.find((r)=>r.key==='OWNER'); assert.ok(ownerRole?.id); assert.ok(ownerRole.permissions.includes('merchant.roles.manage'));

  const managerRole=expect(await req({method:'POST',url:'/v1/merchant/roles',headers:ownerAuth,payload:{key:'TEAM_MANAGER',name:'Team Manager',permission_keys:['merchant.staff.read','merchant.staff.manage','merchant.roles.read','merchant.roles.manage','merchant.sessions.manage','orders.read']}}),201,'create manager role').data.role;
  const workerRole=expect(await req({method:'POST',url:'/v1/merchant/roles',headers:ownerAuth,payload:{key:'ORDER_AGENT',name:'Order Agent',permission_keys:['orders.read']}}),201,'create worker role').data.role;
  const managerEmail=`manager-${suffix}@example.com`;
  const manager=expect(await req({method:'POST',url:'/v1/merchant/staff',headers:ownerAuth,payload:{email:managerEmail,password,display_name:'Manager',role_ids:[managerRole.id]}}),201,'create manager').data.staff;
  assert.deepEqual(manager.roles.map((r)=>r.key),['TEAM_MANAGER']);
  const managerLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:managerEmail,password}}),200,'manager login');
  const managerAuth={authorization:`Bearer ${managerLogin.data.tokens.access_token}`};
  const escalation=expect(await req({method:'POST',url:'/v1/merchant/roles',headers:managerAuth,payload:{key:'ESCALATE',name:'Escalate',permission_keys:['payments.manage']}}),403,'privilege escalation denied');
  assert.equal(escalation.error.code,'ROLE_PRIVILEGE_ESCALATION_FORBIDDEN');
  const ownerAssign=expect(await req({method:'POST',url:'/v1/merchant/staff',headers:managerAuth,payload:{email:`bad-owner-${suffix}@example.com`,password,display_name:'Bad Owner',role_ids:[ownerRole.id]}}),403,'non-owner owner assignment denied');
  assert.equal(ownerAssign.error.code,'OWNER_ROLE_ASSIGNMENT_FORBIDDEN');

  const workerEmail=`worker-${suffix}@example.com`;
  const worker=expect(await req({method:'POST',url:'/v1/merchant/staff',headers:ownerAuth,payload:{email:workerEmail,password,display_name:'Order Worker',role_ids:[workerRole.id]}}),201,'create worker').data.staff;
  assert.ok(!('password_hash' in worker));
  const crossTenant=expect(await req({method:'GET',url:`/v1/merchant/staff/musr_other_${suffix}`,headers:ownerAuth}),404,'cross tenant staff isolated'); assert.equal(crossTenant.error.code,'MERCHANT_STAFF_NOT_FOUND');
  let workerLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:workerEmail,password}}),200,'worker login');
  const workerAuth={authorization:`Bearer ${workerLogin.data.tokens.access_token}`};
  const workerMe=expect(await req({method:'GET',url:'/v1/merchant/me',headers:workerAuth}),200,'worker me').data.user;
  assert.deepEqual(workerMe.roles,['ORDER_AGENT']); assert.deepEqual(workerMe.permissions,['orders.read']);
  const deniedList=expect(await req({method:'GET',url:'/v1/merchant/staff',headers:workerAuth}),403,'worker staff list denied'); assert.equal(deniedList.error.code,'PERMISSION_REQUIRED');

  const sessions=expect(await req({method:'GET',url:`/v1/merchant/staff/${worker.id}/sessions`,headers:ownerAuth}),200,'worker sessions').data.sessions;
  assert.ok(sessions.some((s)=>s.active)); assert.ok(sessions.every((s)=>s.id.startsWith('mses_')));
  const forced=expect(await req({method:'POST',url:`/v1/merchant/staff/${worker.id}/force-logout`,headers:ownerAuth,payload:{}}),200,'force logout').data;
  assert.ok(forced.sessions_revoked>=1);
  expect(await req({method:'GET',url:'/v1/merchant/me',headers:workerAuth}),401,'forced session rejected');

  workerLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:workerEmail,password}}),200,'worker login before reset');
  const reset=expect(await req({method:'POST',url:`/v1/merchant/staff/${worker.id}/reset-password`,headers:ownerAuth,payload:{new_password:resetPassword}}),200,'reset password').data;
  assert.equal(reset.password_reset,true); assert.ok(reset.sessions_revoked>=1);
  expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:workerEmail,password}}),401,'old password rejected');
  workerLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:workerEmail,password:resetPassword}}),200,'new password accepted');

  const inUse=expect(await req({method:'DELETE',url:`/v1/merchant/roles/${workerRole.id}`,headers:ownerAuth}),409,'in-use role protected'); assert.equal(inUse.error.code,'MERCHANT_ROLE_IN_USE');
  expect(await req({method:'PATCH',url:`/v1/merchant/staff/${worker.id}`,headers:ownerAuth,payload:{status:'DISABLED'}}),200,'disable worker');
  expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:workerEmail,password:resetPassword}}),403,'disabled login denied');
  expect(await req({method:'PATCH',url:`/v1/merchant/staff/${worker.id}`,headers:ownerAuth,payload:{status:'ACTIVE',display_name:'Order Worker Updated'}}),200,'reactivate worker');
  const updated=expect(await req({method:'PUT',url:`/v1/merchant/staff/${worker.id}/roles`,headers:ownerAuth,payload:{role_ids:[managerRole.id]}}),200,'replace worker roles').data.staff;
  assert.deepEqual(updated.roles.map((r)=>r.key),['TEAM_MANAGER']);
  expect(await req({method:'DELETE',url:`/v1/merchant/roles/${workerRole.id}`,headers:ownerAuth}),200,'delete unassigned role');
  const ownerProtected=expect(await req({method:'DELETE',url:`/v1/merchant/roles/${ownerRole.id}`,headers:ownerAuth}),403,'system owner role protected'); assert.equal(ownerProtected.error.code,'SYSTEM_ROLE_PROTECTED');
  const selfSuspend=expect(await req({method:'PATCH',url:`/v1/merchant/staff/${login.data.user.id}`,headers:ownerAuth,payload:{status:'SUSPENDED'}}),409,'self suspend denied'); assert.equal(selfSuspend.error.code,'SELF_STATUS_CHANGE_NOT_ALLOWED');
  const selfRoles=expect(await req({method:'PUT',url:`/v1/merchant/staff/${login.data.user.id}/roles`,headers:ownerAuth,payload:{role_ids:[managerRole.id]}}),409,'self role change denied'); assert.equal(selfRoles.error.code,'SELF_ROLE_CHANGE_NOT_ALLOWED');

  const audits=await db.query("SELECT action FROM audit_logs WHERE tenant_id=$1 AND action LIKE 'merchant.%'",[tenantId]);
  const actions=new Set(audits.rows.map((r)=>r.action));
  for(const action of ['merchant.role.create','merchant.staff.create','merchant.staff.force_logout','merchant.staff.password.reset','merchant.staff.update','merchant.staff.roles.update','merchant.role.delete']) assert.ok(actions.has(action),`missing audit ${action}`);

  console.log('PASS tenant-scoped merchant staff creation and read isolation');
  console.log('PASS custom roles and effective permissions are enforced immediately');
  console.log('PASS privilege escalation and OWNER assignment protections');
  console.log('PASS force logout and password reset revoke merchant sessions');
  console.log('PASS disable/reactivate and role replacement lifecycle');
  console.log('PASS system-role/self-lockout protections and durable audit trail');
} finally {
  if(tenantId) await app.db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
  if(otherTenantId) await app.db.query('DELETE FROM tenants WHERE id=$1',[otherTenantId]).catch(()=>{});
  await app.close().catch(()=>{});
}
