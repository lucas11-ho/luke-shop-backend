import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const read=(p)=>readFileSync(p,'utf8').replace(/\r\n?/g,'\n');
const sha=(p)=>createHash('sha256').update(readFileSync(p,'utf8').replace(/\r\n?/g,'\n')).digest('hex');
const tests=[]; const test=(n,f)=>tests.push([n,f]);
const pkg=JSON.parse(read('package.json'));
const migration=read('migrations/006_merchant_staff_rbac_management.sql');
const routes=read('src/modules/merchant/access-routes.js');
const service=read('src/modules/merchant/access-service.js');
const permissions=read('src/core/permissions.js');
const app=read('src/app.js');
const ci=read('.github/workflows/ci.yml');

test('package version carries v0.6.0 RBAC forward',()=>assert.ok(['0.6.0','0.7.0','0.7.1','0.8.0','0.9.0','0.10.0','0.11.0','0.11.1','0.12.0','0.13.0'].includes(pkg.version)));
test('runtime release carries merchant staff RBAC forward',()=>assert.match(read('src/app.js'),/merchantAccessRoutes/));
for(const [file,hash] of Object.entries({
 'migrations/001_multi_tenant_commerce_foundation.sql':'409325e42984e3d495a8af9b411cd3f01da610bef7cf6e2ce99bad563ccb2e19',
 'migrations/002_catalog_inventory_foundation.sql':'9199f9ff88a6aec27ef07cfa4e691133ffa8cd60376c8bba2afe6f4dfc150c97',
 'migrations/003_cart_checkout_orders_foundation.sql':'5eb19b228976135dff6dd17c1cee60e48b8388f1b6b9960a498f1b3c29fa73ed',
 'migrations/004_payments_delivery_promotions_foundation.sql':'d471cada84320666ee496ac1b725b38c87dec1d0b1d7a48b6d138a8b03abdf42',
 'migrations/005_cs_commerce_connector_foundation.sql':'d30daf81749c2585660a7edcd3c5a12dac9fa82f051d85c6bdc1a49ce411fdcf',
})) test(`${file} normalized content remains immutable`,()=>assert.equal(sha(file),hash));
test('migration 006 exists',()=>assert.ok(existsSync('migrations/006_merchant_staff_rbac_management.sql')));
for(const key of ['merchant.staff.read','merchant.staff.manage','merchant.roles.read','merchant.roles.manage','merchant.sessions.manage']) test(`migration 006 adds ${key}`,()=>assert.ok(migration.includes(`'${key}'`)));
test('existing OWNER roles receive new management permissions',()=>assert.match(migration,/WHERE r\.key = 'OWNER'/));
test('DISABLED is additive to legacy BLOCKED status',()=>assert.match(migration,/ACTIVE','SUSPENDED','BLOCKED','DISABLED/));
test('role public IDs are backfilled and unique',()=>{assert.match(migration,/UPDATE merchant_roles[\s\S]*mrol_/);assert.match(migration,/merchant_roles_public_id_uidx/);});
test('session public IDs are backfilled and unique',()=>{assert.match(migration,/UPDATE merchant_sessions[\s\S]*mses_/);assert.match(migration,/merchant_sessions_public_id_uidx/);});
for(const endpoint of ['/v1/merchant/permissions','/v1/merchant/roles','/v1/merchant/staff']) test(`access route includes ${endpoint}`,()=>assert.ok(routes.includes(endpoint)));
test('staff creation requires platform password hashing',()=>{assert.match(routes,/assertPasswordPolicy/);assert.match(routes,/hashPassword\(password\)/);});
test('staff list is tenant scoped',()=>assert.match(routes,/WHERE u\.tenant_id=\$1/));
test('staff detail is tenant scoped',()=>assert.match(service,/WHERE tenant_id = \$1 AND public_id = \$2/));
test('staff serializers do not return password hashes',()=>assert.doesNotMatch(service,/password_hash/));
test('system role modification is blocked',()=>assert.match(routes,/SYSTEM_ROLE_PROTECTED/));
test('OWNER assignment requires an OWNER actor',()=>assert.match(service,/OWNER_ROLE_ASSIGNMENT_FORBIDDEN/));
test('non-owner cannot manage a more privileged staff account',()=>assert.match(service,/STAFF_PRIVILEGE_MANAGEMENT_FORBIDDEN/));
test('permission escalation is blocked',()=>assert.match(service,/ROLE_PRIVILEGE_ESCALATION_FORBIDDEN/));
test('last active owner guard exists',()=>assert.match(service,/LAST_ACTIVE_OWNER_REQUIRED/));
test('self role mutation is blocked',()=>assert.match(routes,/SELF_ROLE_CHANGE_NOT_ALLOWED/));
test('self suspension and disable are blocked',()=>assert.match(routes,/SELF_STATUS_CHANGE_NOT_ALLOWED/));
test('non-active status revokes active sessions',()=>assert.match(routes,/nextStatus !== 'ACTIVE'[\s\S]*merchant_sessions/));
test('password reset revokes sessions',()=>assert.match(routes,/merchant\.staff\.password\.reset[\s\S]*sessions_revoked/s));
test('force logout is tenant and user bound',()=>assert.match(routes,/WHERE tenant_id=\$1 AND merchant_user_id=\$2 AND revoked_at IS NULL/));
test('individual session revocation is tenant user and session bound',()=>assert.match(routes,/merchant_user_id=\$2 AND public_id=\$3/));
test('role assignment uses tenant composite mapping',()=>assert.match(routes,/merchant_user_roles\(tenant_id, merchant_user_id, role_id\)/));
test('new permissions are centralized',()=>{for(const name of ['MERCHANT_STAFF_READ','MERCHANT_STAFF_MANAGE','MERCHANT_ROLES_READ','MERCHANT_ROLES_MANAGE','MERCHANT_SESSIONS_MANAGE'])assert.ok(permissions.includes(name));});
test('merchant access routes are registered',()=>assert.match(app,/register\(merchantAccessRoutes\)/));
test('CI runs merchant staff RBAC lifecycle',()=>assert.match(ci,/Merchant staff and RBAC lifecycle/));
test('migration 007 is absent',()=>assert.equal(existsSync('migrations/007_merchant_staff_rbac_management.sql'),false));
let passed=0;for(const [n,f] of tests){try{f();passed++;console.log(`PASS ${n}`);}catch(e){console.error(`FAIL ${n}`);throw e;}}
console.log(`${passed}/${tests.length} Luke Shop Backend v0.6.0 merchant staff/RBAC checks passed`);
