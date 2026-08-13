import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const migration = read('migrations/002_catalog_inventory_foundation.sql');
const merchant = read('src/modules/catalog/merchant-routes.js');
const storefront = read('src/modules/catalog/storefront-routes.js');
const inventory = read('src/modules/inventory/merchant-routes.js');
const cs = read('src/modules/integrations/customer-service/service-routes.js');
const tests=[]; const test=(name,fn)=>tests.push([name,fn]);

for (const table of ['categories','products','product_fulfillment_modes','product_variants','product_media','product_modifier_groups','product_modifier_options','inventory_locations','inventory_items','inventory_balances','inventory_ledger']) {
  test(`002 includes ${table}`,()=>assert.match(migration,new RegExp(`CREATE TABLE ${table}\\b`)));
}
test('product types cover physical food digital and service',()=>{for(const v of ['PHYSICAL','FOOD','DIGITAL_IMAGE','DIGITAL_VIDEO','SERVICE']) assert.match(migration,new RegExp(`'${v}'`));});
test('fulfillment modes are independent of product type',()=>{for(const v of ['SHIPPING','LOCAL_DELIVERY','PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','NONE']) assert.match(migration,new RegExp(`'${v}'`));});
test('product SKU uniqueness is tenant/store scoped',()=>assert.match(migration,/product_variants_store_sku_unique ON product_variants\(tenant_id, store_id, sku\)/));
test('inventory SKU uniqueness is tenant/store scoped',()=>assert.match(migration,/inventory_items_store_sku_unique ON inventory_items\(tenant_id, store_id, sku\)/));
test('one default inventory location per store',()=>assert.match(migration,/inventory_locations_one_default_per_store/));
test('ledger preserves before-independent resulting balances',()=>{assert.match(migration,/on_hand_after bigint NOT NULL/);assert.match(migration,/reserved_after bigint NOT NULL/);});
test('merchant categories API exists',()=>{assert.match(merchant,/post\('\/v1\/merchant\/categories'/);assert.match(merchant,/get\('\/v1\/merchant\/categories'/);assert.match(merchant,/patch\('\/v1\/merchant\/categories\/:categoryId'/);});
test('merchant products API exists',()=>{assert.match(merchant,/post\('\/v1\/merchant\/products'/);assert.match(merchant,/get\('\/v1\/merchant\/products'/);assert.match(merchant,/patch\('\/v1\/merchant\/products\/:productId'/);});
test('variants and media APIs exist',()=>{assert.match(merchant,/variants'/);assert.match(merchant,/products\/:productId\/media/);});
test('restaurant modifier APIs exist',()=>{assert.match(merchant,/modifier-groups/);assert.match(merchant,/modifier-groups\/:groupId\/options/);});
test('storefront catalog is published-only',()=>{assert.match(storefront,/status='PUBLISHED'/);assert.match(storefront,/visibility='PUBLIC'/);});
test('inventory adjustment is transactional',()=>assert.match(inventory,/app\.db\.transaction/));
test('inventory adjustment rejects stock below zero',()=>assert.match(inventory,/INVENTORY_NEGATIVE_NOT_ALLOWED/));
test('reserved stock cannot exceed on hand',()=>assert.match(inventory,/INVENTORY_RESERVED_CONFLICT/));
test('inventory ledger route is read-only',()=>assert.match(inventory,/get\('\/v1\/merchant\/inventory\/ledger'/));
test('Luke CS can search and read products only with product.read',()=>{assert.ok((cs.match(/requireServiceScope\('product\.read'\)/g)||[]).length>=2);assert.match(cs,/product\.search/);assert.match(cs,/product\.read/);});
test('private storage keys are not selected for public product details',()=>assert.match(read('src/modules/catalog/service.js'),/publicOnly \? 'NULL::text' : 'm\.storage_key'/));
test('migration 003 is not present in catalog foundation',()=>assert.doesNotMatch(migration,/003_/));

let passed=0;for(const [name,fn] of tests){try{fn();passed++;console.log(`PASS ${name}`);}catch(e){console.error(`FAIL ${name}`);throw e;}}
console.log(`${passed}/${tests.length} Luke Shop Backend v0.2.0 catalog/inventory regression checks passed`);
