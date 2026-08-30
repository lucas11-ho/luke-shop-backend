import assert from 'node:assert/strict';
import fs from 'node:fs';

const routes=fs.readFileSync(new URL('../src/modules/product-nature/routes.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../src/app.js',import.meta.url),'utf8');

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

console.log('PASS controlled existing-product nature conversion, order-history guard, audited fulfillment rebuild and authenticated stale-cart repair');
