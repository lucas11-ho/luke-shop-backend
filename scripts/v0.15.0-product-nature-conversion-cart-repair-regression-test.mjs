import assert from 'node:assert/strict';
import fs from 'node:fs';

const routes=fs.readFileSync(new URL('../src/modules/product-nature/routes.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const checkout=fs.readFileSync(new URL('../src/modules/orders/customer-routes.js',import.meta.url),'utf8');
const migration014=fs.readFileSync(new URL('../migrations/014_customer_identity_fulfillment_notifications.sql',import.meta.url),'utf8');
const migration024=fs.readFileSync(new URL('../migrations/024_digital_order_item_snapshot_compatibility.sql',import.meta.url),'utf8');

assert.match(routes,/app\.put\('\/v1\/merchant\/products\/:productId\/nature'/,'Merchant product nature conversion endpoint must exist');
assert.match(routes,/PRODUCT_NATURE_CHANGE_HAS_ORDER_HISTORY/,'Nature conversion must reject products with order history');
assert.match(routes,/catalog\.product\.nature_change/,'Nature conversion must be audited');
assert.match(routes,/product_digital_policies/,'Digital conversion must persist the digital access policy');
assert.match(routes,/DELETE FROM product_fulfillment_modes/,'Nature conversion must replace incompatible fulfillment modes atomically');
assert.match(routes,/repaired_active_cart_items/,'Nature conversion must report repaired active cart items');
assert.match(routes,/app\.post\('\/v1\/customer\/cart\/repair'/,'Authenticated customer cart repair endpoint must exist');
assert.match(routes,/NOT \(ci\.fulfillment_mode = ANY/,'Active cart repair must only replace incompatible fulfillment modes');
assert.match(routes,/productFulfillmentPolicy\(item\.product_type\)/,'Cart repair must derive fallback modes from the authoritative product nature policy');
assert.match(app,/import \{ productNatureRoutes \} from '\.\/modules\/product-nature\/routes\.js'/,'Application must import Product Nature routes');
assert.match(app,/register\(productNatureRoutes\)/,'Application must register Product Nature routes exactly once');
assert.equal((app.match(/register\(productNatureRoutes\)/g)||[]).length,1,'Product Nature routes must not be registered twice');

assert.match(migration014,/product_type_snapshot IN \('PHYSICAL','FOOD','DIGITAL','SERVICE'\)/,'Applied migration 014 must remain byte-compatible with its historical DIGITAL snapshot constraint');
assert.match(migration024,/DROP CONSTRAINT IF EXISTS order_items_product_type_snapshot_check/,'Migration 024 must replace the historical order-item product type constraint additively');
assert.match(migration024,/'DIGITAL_IMAGE'/,'Migration 024 must permit DIGITAL_IMAGE order snapshots');
assert.match(migration024,/'DIGITAL_VIDEO'/,'Migration 024 must permit DIGITAL_VIDEO order snapshots');
assert.match(migration024,/'DIGITAL'/,'Migration 024 must preserve legacy DIGITAL order snapshots');
assert.match(checkout,/item\.fulfillment_mode,item\.product_type,item\.title_snapshot/,'Checkout must freeze the exact current product subtype into the order item snapshot');

console.log('PASS controlled Product Nature conversion, stale-cart repair and additive digital order snapshot compatibility');
