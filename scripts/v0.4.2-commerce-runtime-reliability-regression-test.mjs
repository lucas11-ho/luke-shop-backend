import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read=(p)=>readFileSync(p,'utf8').replace(/\r\n?/g,'\n');
const pkg=JSON.parse(read('package.json'));
const tests=[];
const test=(name,fn)=>tests.push([name,fn]);

const promotionRoutes=read('src/modules/promotions/merchant-routes.js');
const defaults=read('src/modules/commerce/defaults.js');
const bootstrap=read('src/scripts/bootstrap-tenant.js');
const catalogTest=read('scripts/catalog-inventory-lifecycle-test.mjs');
const ordersTest=read('scripts/orders-lifecycle-test.mjs');
const commerceTest=read('scripts/payments-delivery-promotions-lifecycle-test.mjs');

test('package version carries v0.4.2 reliability repair forward',()=>assert.ok(['0.4.2','0.5.0','0.6.0','0.7.0','0.7.1','0.8.0','0.9.0','0.10.0','0.11.0','0.11.1','0.12.0','0.13.0','0.14.0'].includes(pkg.version)));
test('runtime release marker carries v0.4.2 reliability repair forward',()=>assert.match(read('src/config.js'),/(0\.4\.2-commerce-runtime-reliability-repair|0\.5\.0-luke-cs-commerce-connector-ai-tool-gateway|0\.6\.0-merchant-staff-rbac-management|0\.7\.0-platform-control-plane-storefront-experience|0\.7\.1-multi-tenant-storefront-routing|0\.8\.0-media-asset-library|0\.9\.0-experience-commerce-workflow|0\.10\.0-store-designer-v3|0\.11\.0-operations-control-completion|0\.11\.1-customer-experience-reliability|0\.12\.0-delivery-location-status-visuals|0\.13\.0-identity-fulfillment-notifications)/));
test('promotion code detail qualifies pc.public_id',()=>assert.ok(promotionRoutes.includes('SELECT pc.public_id AS id,pc.code,pc.status,pc.usage_limit FROM promotion_codes pc JOIN promotions p')));
test('promotion code detail has no ambiguous joined SELECT public_id',()=>assert.equal(/SELECT\s+public_id\s+AS\s+id,code,status,usage_limit\s+FROM\s+promotion_codes\s+pc\s+JOIN/i.test(promotionRoutes),false));
test('fulfillment history qualifies joined columns',()=>assert.ok(read('src/modules/delivery/service.js').includes('SELECT h.from_status,h.to_status,h.reason,h.actor_type,h.created_at FROM fulfillment_status_history h JOIN order_fulfillments f')));
test('commerce defaults helper inserts manual payment idempotently',()=>{assert.ok(defaults.includes("'MANUAL'"));assert.ok(defaults.includes('ON CONFLICT (tenant_id,store_id,code) DO NOTHING'));});
test('commerce defaults helper inserts pickup shipping and local delivery',()=>{for(const code of ["'PICKUP'","'SHIPPING'","'LOCAL'"])assert.ok(defaults.includes(code));});
test('bootstrap tenant uses shared commerce defaults helper through provisioning',()=>{assert.ok(bootstrap.includes('provisionTenant'));assert.ok(read('src/modules/platform/provisioning.js').includes('ensureStoreCommerceDefaults(client, { tenantId, storeId })'));});
test('orders lifecycle fixture provisions commerce defaults',()=>assert.ok(ordersTest.includes('ensureStoreCommerceDefaults(client,{tenantId,storeId})')));
test('orders lifecycle fixture exercises defaults helper idempotency',()=>assert.ok(ordersTest.includes('// idempotency guard')));
test('commerce lifecycle fixture uses shared commerce defaults helper',()=>assert.ok(commerceTest.includes('ensureStoreCommerceDefaults(client,{tenantId,storeId})')));
test('commerce lifecycle asserts exactly one MANUAL and three delivery defaults',()=>{assert.ok(commerceTest.includes('manual_count,1'));assert.ok(commerceTest.includes('delivery_count,3'));});
test('storefront media test requires storage_key omission',()=>assert.ok(catalogTest.includes("!Object.prototype.hasOwnProperty.call(m,'storage_key')")));
test('storefront media test rejects private storage path leakage',()=>assert.ok(catalogTest.includes('private storage key leaked to storefront')));
test('storefront public media serializer omits storage_key',()=>{const service=read('src/modules/catalog/service.js');const safe=service.slice(service.indexOf('const safeMedia'));assert.ok(safe.includes('public_id: row.public_id'));assert.equal(safe.split('const safeModifierGroups')[0].includes('storage_key:'),false);});
test('v0.4.2 repair migration was never introduced',()=>assert.equal(existsSync('migrations/005_commerce_runtime_reliability_repair.sql'),false));
test('migrations 001-004 remain present',()=>{for(const file of ['001_multi_tenant_commerce_foundation.sql','002_catalog_inventory_foundation.sql','003_cart_checkout_orders_foundation.sql','004_payments_delivery_promotions_foundation.sql'])assert.ok(existsSync(`migrations/${file}`));});

let passed=0;
for(const [name,fn] of tests){
  try{fn();passed++;console.log(`PASS ${name}`);}
  catch(error){console.error(`FAIL ${name}`);throw error;}
}
console.log(`${passed}/${tests.length} Luke Shop Backend v0.4.2 commerce runtime reliability checks passed`);
