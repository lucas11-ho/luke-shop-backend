import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const normalizedTextBytes = (p) => Buffer.from(readFileSync(p, 'utf8').replace(/\r\n?/g, '\n'), 'utf8');
const sha256 = (p) => createHash('sha256').update(normalizedTextBytes(p)).digest('hex');
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const pkg = JSON.parse(read('package.json'));
const migration1 = read('migrations/001_multi_tenant_commerce_foundation.sql');
const migration2 = read('migrations/002_catalog_inventory_foundation.sql');
const migration3 = read('migrations/003_cart_checkout_orders_foundation.sql');
const migration4 = read('migrations/004_payments_delivery_promotions_foundation.sql');
const migration5 = read('migrations/005_cs_commerce_connector_foundation.sql');
const migration6 = read('migrations/006_merchant_staff_rbac_management.sql');
const customerAuth = read('src/modules/auth/customer-routes.js');
const merchantCustomers = read('src/modules/merchant/customer-routes.js');
const merchantCatalog = read('src/modules/catalog/merchant-routes.js');
const storefrontCatalog = read('src/modules/catalog/storefront-routes.js');
const inventory = read('src/modules/inventory/merchant-routes.js');
const customerOrders = read('src/modules/orders/customer-routes.js');
const merchantOrders = read('src/modules/orders/merchant-routes.js');
const orderService = read('src/modules/orders/service.js');
const merchantPayments = read('src/modules/payments/merchant-routes.js');
const merchantDelivery = read('src/modules/delivery/merchant-routes.js');
const merchantPromotions = read('src/modules/promotions/merchant-routes.js');
const customerCommerce = read('src/modules/commerce/customer-routes.js');
const commerceDefaults = read('src/modules/commerce/defaults.js');
const serviceAuth = read('src/modules/integrations/customer-service/service-auth.js');
const serviceRoutes = read('src/modules/integrations/customer-service/service-routes.js');
const serviceMerchant = read('src/modules/integrations/customer-service/merchant-routes.js');
const tenantPlugin = read('src/plugins/tenant.js');
const authPlugin = read('src/plugins/auth.js');
const app = read('src/app.js');
const passwords = read('src/core/passwords.js');
const tokens = read('src/core/tokens.js');
const permissions = read('src/core/permissions.js');
const merchantAccess = read('src/modules/merchant/access-routes.js');
const merchantAccessService = read('src/modules/merchant/access-service.js');

// The foundation migration is immutable across the catalog release.
test('release remains compatible through v0.9.0', () => assert.ok(['0.9.0','0.10.0','0.11.0'].includes(pkg.version)));
test('Node 24+ is required', () => assert.match(pkg.engines.node, />=24/));
test('Fastify v5 is pinned', () => assert.match(pkg.dependencies.fastify, /^5\./));
test('migration 001 normalized content is immutable', () => {
  assert.ok(existsSync('migrations/001_multi_tenant_commerce_foundation.sql'));
  assert.equal(sha256('migrations/001_multi_tenant_commerce_foundation.sql'), '409325e42984e3d495a8af9b411cd3f01da610bef7cf6e2ce99bad563ccb2e19');
});
test('migration 002 normalized content is immutable', () => { assert.ok(existsSync('migrations/002_catalog_inventory_foundation.sql')); assert.equal(sha256('migrations/002_catalog_inventory_foundation.sql'), '9199f9ff88a6aec27ef07cfa4e691133ffa8cd60376c8bba2afe6f4dfc150c97'); });
test('migration 003 normalized content is immutable', () => { assert.ok(existsSync('migrations/003_cart_checkout_orders_foundation.sql')); assert.equal(sha256('migrations/003_cart_checkout_orders_foundation.sql'), '5eb19b228976135dff6dd17c1cee60e48b8388f1b6b9960a498f1b3c29fa73ed'); });
test('migration 004 normalized content is immutable', () => { assert.ok(existsSync('migrations/004_payments_delivery_promotions_foundation.sql')); assert.equal(sha256('migrations/004_payments_delivery_promotions_foundation.sql'), 'd471cada84320666ee496ac1b725b38c87dec1d0b1d7a48b6d138a8b03abdf42'); });
test('migration 005 normalized content is immutable', () => { assert.ok(existsSync('migrations/005_cs_commerce_connector_foundation.sql')); assert.equal(sha256('migrations/005_cs_commerce_connector_foundation.sql'), 'd30daf81749c2585660a7edcd3c5a12dac9fa82f051d85c6bdc1a49ce411fdcf'); });
test('migration 006 exists', () => assert.ok(existsSync('migrations/006_merchant_staff_rbac_management.sql')));
for (const table of ['tenants','tenant_settings','stores','customers','customer_sessions','merchant_users','merchant_roles','merchant_sessions','integration_clients','customer_service_access_logs','audit_logs']) {
  test(`migration 001 creates ${table}`, () => assert.match(migration1, new RegExp(`CREATE TABLE ${table}\\b`)));
}
for (const table of ['categories','products','product_fulfillment_modes','product_variants','product_media','product_modifier_groups','product_modifier_options','inventory_locations','inventory_items','inventory_balances','inventory_ledger']) {
  test(`migration 002 creates ${table}`, () => assert.match(migration2, new RegExp(`CREATE TABLE ${table}\\b`)));
}
for (const table of ['carts','cart_items','checkout_sessions','orders','order_items','order_addresses','order_status_history','inventory_reservations']) {
  test(`migration 003 creates ${table}`, () => assert.match(migration3, new RegExp(`CREATE TABLE ${table}\\b`)));
}
test('customer uniqueness is tenant scoped', () => assert.match(migration1, /UNIQUE\(tenant_id, email\)/));
test('merchant role assignment is tenant scoped by composite foreign keys', () => { assert.match(migration1, /CREATE TABLE merchant_user_roles[\s\S]*tenant_id uuid NOT NULL/); assert.match(migration1, /FOREIGN KEY \(tenant_id, role_id\)/); });
test('catalog tables bind records to tenant and store', () => {
  assert.match(migration2, /CREATE TABLE products[\s\S]*tenant_id uuid NOT NULL[\s\S]*store_id uuid NOT NULL[\s\S]*FOREIGN KEY \(tenant_id, store_id\) REFERENCES stores/);
  assert.match(migration2, /CREATE TABLE product_variants[\s\S]*FOREIGN KEY \(tenant_id, store_id, product_id\) REFERENCES products/);
});
test('inventory FKs preserve tenant and store isolation', () => {
  assert.match(migration2, /CREATE TABLE inventory_balances[\s\S]*FOREIGN KEY \(tenant_id, store_id, inventory_item_id\)/);
  assert.match(migration2, /FOREIGN KEY \(tenant_id, store_id, location_id\) REFERENCES inventory_locations/);
});
test('migration grants catalog and inventory permissions to existing owners', () => {
  assert.match(migration2, /'catalog\.read'/); assert.match(migration2, /'inventory\.write'/); assert.match(migration2, /WHERE r\.key = 'OWNER'/);
});
test('public tenant resolver requires x-tenant-slug', () => assert.match(tenantPlugin, /x-tenant-slug/));
test('customer auth queries include tenant_id', () => assert.match(customerAuth, /WHERE tenant_id = \$1 AND email = \$2/));
test('merchant customer detail is tenant scoped', () => assert.match(merchantCustomers, /WHERE tenant_id = \$1 AND public_id = \$2/));
test('access auth checks active session and tenant', () => assert.match(authPlugin, /s\.revoked_at IS NULL.*t\.status = 'ACTIVE'/s));
test('passwords use scrypt and timingSafeEqual', () => { assert.match(passwords, /scrypt/); assert.match(passwords, /timingSafeEqual/); });
test('refresh tokens are random and stored as hashes', () => { assert.match(tokens, /randomBytes\(48\)/); assert.match(tokens, /sha256/); });
test('service credentials are hashed using server pepper', () => assert.match(tokens, /createHmac\('sha256', pepper\)/));
test('catalog permissions are centralized', () => { assert.match(permissions, /CATALOG_READ/); assert.match(permissions, /INVENTORY_WRITE/); });
test('merchant catalog routes require catalog permissions', () => { assert.match(merchantCatalog, /PERMISSIONS\.CATALOG_READ/); assert.match(merchantCatalog, /PERMISSIONS\.CATALOG_WRITE/); });
test('merchant inventory routes require inventory permissions', () => { assert.match(inventory, /PERMISSIONS\.INVENTORY_READ/); assert.match(inventory, /PERMISSIONS\.INVENTORY_WRITE/); });
test('merchant product reads are tenant and store scoped', () => assert.match(merchantCatalog, /WHERE tenant_id=\$1 AND store_id=\$2 AND public_id=\$3/));
test('storefront only exposes published products', () => { assert.match(storefrontCatalog, /p\.status='PUBLISHED'/); assert.match(storefrontCatalog, /m\.visibility='PUBLIC'/); });
test('private media requires a storage key and no public URL', () => assert.match(migration2, /visibility = 'PRIVATE' AND storage_key IS NOT NULL AND url IS NULL/));
test('inventory adjustment locks balances before mutation', () => assert.match(inventory, /inventory_balances[\s\S]*FOR UPDATE/));
test('inventory ledger is append-only in merchant route', () => { assert.match(inventory, /INSERT INTO inventory_ledger/); assert.doesNotMatch(inventory, /UPDATE inventory_ledger/); assert.doesNotMatch(inventory, /DELETE FROM inventory_ledger/); });
test('negative stock is blocked', () => assert.match(inventory, /INVENTORY_NEGATIVE_NOT_ALLOWED/));
test('Luke CS product.read scope is available', () => { assert.match(serviceMerchant, /'product\.read'/); assert.match(serviceRoutes, /'product\.read': true/); });
test('Luke CS product reads are published and tenant scoped', () => { assert.match(serviceRoutes, /p\.tenant_id=\$1 AND p\.store_id=\$2 AND p\.status='PUBLISHED'/); assert.match(serviceRoutes, /productDetails/); });
test('CS integration accesses are logged', () => assert.match(serviceRoutes, /customer_service_access_logs/));
test('structured global error handler exists', () => assert.match(app, /setErrorHandler/));
test('Fastify client errors preserve their 4xx semantics', () => { assert.match(app, /normalizeHttpClientError/); assert.match(app, /clientError\.statusCode/); });
test('security plugins are registered', () => { assert.match(app, /register\(helmet/); assert.match(app, /register\(rateLimit/); assert.match(app, /register\(cors/); });
test('catalog and inventory modules are registered', () => { assert.match(app, /register\(merchantCatalogRoutes\)/); assert.match(app, /register\(storefrontCatalogRoutes\)/); assert.match(app, /register\(merchantInventoryRoutes\)/); });
test('CI includes catalog lifecycle integration test', () => assert.match(read('.github/workflows/ci.yml'), /Catalog and inventory lifecycle/));
test('database queries are parameterized in protected product reads', () => assert.doesNotMatch(serviceRoutes, /public_id\s*=\s*['"`]\s*\+/));

test('order permissions are centralized and granted to existing owners', () => { assert.match(permissions, /ORDERS_READ/); assert.match(permissions, /ORDERS_MANAGE/); assert.match(migration3, /'orders\.read'/); assert.match(migration3, /WHERE r\.key = 'OWNER'/); });
test('customer cart and checkout routes require customer auth', () => { assert.match(customerOrders, /requireCustomerAuth/); assert.match(customerOrders, /\/v1\/customer\/checkout/); });
test('merchant order routes require orders permissions', () => { assert.match(merchantOrders, /PERMISSIONS\.ORDERS_READ/); assert.match(merchantOrders, /PERMISSIONS\.ORDERS_MANAGE/); });
test('checkout reserves inventory with row locks', () => { assert.match(customerOrders, /inventory_balances[\s\S]*FOR UPDATE/); assert.match(customerOrders, /movement_type[^\n]*RESERVE|\'RESERVE\'/); });
test('paid transition consumes reservations as SALE', () => { assert.match(merchantOrders, /consumeReservations/); assert.match(orderService, /'SALE'/); });
test('cancel releases active reservations', () => { assert.match(customerOrders, /releaseReservations/); assert.match(orderService, /'RELEASE'/); });
test('order state machines separate physical food digital and service', () => { for (const value of ['PHYSICAL','FOOD','DIGITAL','SERVICE','MIXED']) assert.match(orderService, new RegExp(`${value}:`)); });
test('checkout idempotency is database-enforced per tenant customer', () => assert.match(migration3, /UNIQUE\(tenant_id, customer_id, idempotency_key\)/));
test('order snapshots preserve pricing and selected modifiers', () => { assert.match(migration3, /title_snapshot/); assert.match(migration3, /selected_modifiers jsonb/); assert.match(migration3, /line_total numeric/); });
test('CS order access requires both customer and order context', () => { assert.match(serviceRoutes, /customers\/:customerId\/orders\/:orderRef/); assert.doesNotMatch(serviceRoutes, /app\.get\('\/v1\/customer-service\/orders\/:orderRef'/); });
test('Luke CS order scopes are read only', () => { assert.match(serviceMerchant, /'orders\.read'/); assert.match(serviceMerchant, /'order_status\.read'/); assert.match(serviceRoutes, /'orders\.read': true/); assert.match(serviceRoutes, /'orders\.cancel': false/); });
test('order expiry maintenance releases stale payment reservations', () => { const expiry=read('src/scripts/expire-orders.js'); assert.match(expiry, /releaseReservations/); assert.match(expiry, /Payment reservation expired/); });
test('cart checkout and order modules are registered', () => { assert.match(app, /register\(customerOrderRoutes\)/); assert.match(app, /register\(merchantOrderRoutes\)/); });
test('CI includes orders lifecycle integration test', () => assert.match(read('.github/workflows/ci.yml'), /Cart checkout and orders lifecycle/));

for (const table of ['payment_methods','order_payments','payment_attempts','payment_events','delivery_methods','order_fulfillments','fulfillment_status_history','promotions','promotion_codes','promotion_targets','promotion_redemptions','order_adjustments']) {
  test(`migration 004 creates ${table}`, () => assert.match(migration4, new RegExp(`CREATE TABLE ${table}\\b`)));
}
test('v0.4 permissions are additive and granted to existing owners', () => { for (const key of ['payments.read','payments.manage','delivery.read','delivery.manage','promotions.read','promotions.write']) assert.ok(migration4.includes(`'${key}'`)); assert.match(migration4,/WHERE r.key='OWNER'/); });
test('payment provider configuration contains public data only', () => { assert.match(migration4,/public_config jsonb/); assert.doesNotMatch(migration4,/secret|api_key|private_key/i); });
test('payment confirmation is tied to order and consumes reservation', () => { assert.match(merchantPayments,/confirmPayment/); assert.match(read('src/modules/payments/service.js'),/consumeReservations/); });
test('payment failure preserves order payment state', () => { assert.match(merchantPayments,/payment\/fail/); assert.match(read('src/modules/payments/service.js'),/PAYMENT_FAILED/); });
test('delivery methods support shipping local delivery and pickup', () => { for (const mode of ['SHIPPING','LOCAL_DELIVERY','PICKUP']) assert.match(migration4,new RegExp(`'${mode}'`)); });
test('fulfillment transitions are explicit', () => { const delivery=read('src/modules/delivery/service.js'); assert.match(delivery,/FULFILLMENT_TRANSITION_INVALID/); assert.match(delivery,/OUT_FOR_DELIVERY/); });
test('promotions support percentage fixed free-delivery and BOGO rules', () => { for (const type of ['PERCENTAGE','FIXED_AMOUNT','FREE_DELIVERY','BOGO']) assert.match(migration4,new RegExp(`'${type}'`)); });
test('promotion usage is tenant and customer scoped', () => { const promo=read('src/modules/promotions/service.js'); assert.match(promo,/promotion_redemptions/); assert.match(promo,/customer_id/); });
test('checkout integrates delivery promotion and payment foundations', () => { assert.match(customerOrders,/resolveDeliverySelection/); assert.match(customerOrders,/resolvePromotion/); assert.match(customerOrders,/createOrderPayment/); assert.match(customerOrders,/createOrderFulfillments/); });
test('storefront exposes active payment and delivery choices only', () => { assert.match(customerCommerce,/payment-methods/); assert.match(customerCommerce,/delivery-methods/); assert.match(customerCommerce,/status='ACTIVE'/); });
test('merchant commerce routes use dedicated permissions', () => { assert.match(merchantPayments,/PERMISSIONS.PAYMENTS_/); assert.match(merchantDelivery,/PERMISSIONS.DELIVERY_/); assert.match(merchantPromotions,/PERMISSIONS.PROMOTIONS_/); });
test('Luke CS payment and delivery capabilities are read-only and available', () => { assert.match(serviceRoutes,/'payments.read': true/); assert.match(serviceRoutes,/'delivery.read': true/); assert.match(serviceMerchant,/'payments.read'/); assert.match(serviceMerchant,/'delivery.read'/); assert.match(serviceRoutes,/'refunds.create': false/); });
test('Luke CS payment and delivery reads remain customer-bound', () => { assert.match(serviceRoutes,/customers\/:customerId\/orders\/:orderRef\/payment/); assert.match(serviceRoutes,/customers\/:customerId\/orders\/:orderRef\/delivery/); });
test('v0.4 modules are registered', () => { assert.match(app,/register\(merchantPaymentRoutes\)/); assert.match(app,/register\(merchantDeliveryRoutes\)/); assert.match(app,/register\(merchantPromotionRoutes\)/); assert.match(app,/register\(customerCommerceRoutes\)/); });
test('CI includes v0.4 commerce lifecycle integration test', () => assert.match(read('.github/workflows/ci.yml'), /Payments delivery and promotions lifecycle/));

test('v0.4.1 storefront commerce routes use the defined tenant guard', () => { const text=read('src/modules/commerce/customer-routes.js'); assert.equal(text.includes('requirePublicTenant'), false); assert.ok(text.includes('app.requireTenant')); });
test('v0.4.1 inventory row lock targets inventory_items only', () => { const text=read('src/modules/inventory/merchant-routes.js'); assert.ok(text.includes("i.status='ACTIVE' FOR UPDATE OF i")); });
test('v0.4.1 missing bearer token is not rewritten as ACCESS_TOKEN_INVALID', () => { const text=read('src/plugins/auth.js'); assert.ok(text.includes('const token = bearer(request);')); });
test('v0.4.2 promotion joins qualify public_id ownership', () => {
  assert.match(merchantPromotions, /SELECT pc\.public_id AS id,pc\.code,pc\.status,pc\.usage_limit FROM promotion_codes pc JOIN promotions p/);
  assert.doesNotMatch(merchantPromotions, /SELECT public_id AS id,code,status,usage_limit FROM promotion_codes pc JOIN promotions p/);
});
test('v0.4.2 fulfillment history qualifies joined columns', () => assert.match(read('src/modules/delivery/service.js'), /SELECT h\.from_status,h\.to_status,h\.reason,h\.actor_type,h\.created_at FROM fulfillment_status_history h JOIN order_fulfillments f/));
test('v0.4.2 store commerce defaults are idempotent by tenant store and code', () => {
  assert.match(commerceDefaults, /ON CONFLICT \(tenant_id,store_id,code\) DO NOTHING/);
  assert.match(commerceDefaults, /'MANUAL'/);
  assert.match(commerceDefaults, /'PICKUP'/);
  assert.match(commerceDefaults, /'SHIPPING'/);
  assert.match(commerceDefaults, /'LOCAL'/);
});
test('v0.4.2 bootstrap and order fixture share commerce defaults', () => {
  const bootstrap=read('src/scripts/bootstrap-tenant.js');
  const provisioning=read('src/modules/platform/provisioning.js');
  assert.match(bootstrap, /provisionTenant/);
  assert.match(provisioning, /ensureStoreCommerceDefaults/);
  assert.match(read('scripts/orders-lifecycle-test.mjs'), /ensureStoreCommerceDefaults/);
});
test('v0.4.2 storefront media test enforces omission of private storage fields', () => {
  const text=read('scripts/catalog-inventory-lifecycle-test.mjs');
  assert.match(text, /hasOwnProperty\.call\(m,'storage_key'\)/);
  assert.match(text, /private storage key leaked to storefront/);
});
test('v0.4.2 adds no migration 005', () => assert.equal(existsSync('migrations/005_commerce_runtime_reliability_repair.sql'), false));

for (const table of ['customer_service_policies','customer_service_contexts','customer_service_request_nonces','customer_service_tool_calls']) {
  test(`migration 005 creates ${table}`, () => assert.match(migration5, new RegExp(`CREATE TABLE ${table}\\b`)));
}
test('v0.5 integration clients distinguish STAFF and AI credentials', () => assert.match(migration5, /usage_mode[\s\S]*'STAFF','AI'/));
test('v0.5 signed contexts bind customer session and store', () => { assert.match(migration5,/customer_session_id/); assert.match(migration5,/allowed_tools/); assert.match(migration5,/jti uuid/); });
test('v0.5 request replay protection stores nonce hashes only', () => { assert.match(migration5,/nonce_hash char\(64\)/); assert.doesNotMatch(migration5,/\bnonce text\b/); });
test('v0.5 tool audit stores result code not response payload', () => { assert.match(migration5,/customer_service_tool_calls/); assert.match(migration5,/result_code text NOT NULL/); assert.doesNotMatch(migration5,/result_payload|response_payload/); });
test('v0.5 connector routes are registered', () => { assert.match(app,/customerSupportContextRoutes/); assert.match(app,/customerServiceToolRoutes/); });
test('v0.5 tool gateway requires signed service token', () => assert.match(read('src/modules/integrations/customer-service/tool-routes.js'), /requireSignedCustomerServiceToken/));
test('v0.5 CI includes connector lifecycle', () => assert.match(read('.github/workflows/ci.yml'),/Luke CS Commerce Connector lifecycle/));


test('v0.6 migration adds staff and RBAC permissions', () => {
  for (const key of ['merchant.staff.read','merchant.staff.manage','merchant.roles.read','merchant.roles.manage','merchant.sessions.manage']) assert.ok(migration6.includes(`'${key}'`));
  assert.match(migration6, /WHERE r\.key = 'OWNER'/);
});
test('v0.6 merchant status supports explicit DISABLED without dropping legacy BLOCKED', () => { assert.match(migration6,/ACTIVE','SUSPENDED','BLOCKED','DISABLED/); });
test('v0.6 roles and sessions gain public identifiers', () => { assert.match(migration6,/merchant_roles[\s\S]*public_id text/); assert.match(migration6,/merchant_sessions[\s\S]*public_id text/); });
test('v0.6 staff APIs are tenant scoped', () => { assert.match(merchantAccess,/WHERE u\.tenant_id=\$1/); assert.match(merchantAccessService,/WHERE tenant_id = \$1 AND public_id = \$2/); });
test('v0.6 staff API never selects password hash for responses', () => { assert.doesNotMatch(merchantAccessService,/SELECT[\s\S]{0,160}password_hash/); });
test('v0.6 new staff passwords use the platform password hasher', () => { assert.match(merchantAccess,/hashPassword\(password\)/); assert.match(merchantAccess,/assertPasswordPolicy/); });
test('v0.6 role assignment blocks privilege escalation', () => { assert.match(merchantAccessService,/ROLE_PRIVILEGE_ESCALATION_FORBIDDEN/); assert.match(merchantAccessService,/OWNER_ROLE_ASSIGNMENT_FORBIDDEN/); });
test('v0.6 non-owner cannot manage a more privileged staff account', () => assert.match(merchantAccessService,/STAFF_PRIVILEGE_MANAGEMENT_FORBIDDEN/));
test('v0.6 last active owner is protected', () => { assert.match(merchantAccessService,/LAST_ACTIVE_OWNER_REQUIRED/); assert.match(merchantAccess,/assertLastActiveOwnerPreserved/); });
test('v0.6 system roles cannot be modified or deleted', () => { assert.match(merchantAccess,/SYSTEM_ROLE_PROTECTED/); });
test('v0.6 staff suspension and disable revoke active sessions', () => { assert.match(merchantAccess,/nextStatus !== 'ACTIVE'[\s\S]*UPDATE merchant_sessions/); });
test('v0.6 password reset revokes all target sessions', () => { assert.match(merchantAccess,/merchant\.staff\.password\.reset/); assert.match(merchantAccess,/password_changed_at=now\(\)/); });
test('v0.6 force logout and individual session revoke are audited', () => { assert.match(merchantAccess,/merchant\.staff\.force_logout/); assert.match(merchantAccess,/merchant\.session\.revoke/); });
test('v0.6 role permission replacement is explicit and audited', () => { assert.match(merchantAccess,/DELETE FROM merchant_role_permissions/); assert.match(merchantAccess,/merchant\.role\.permissions\.update/); });
test('v0.6 access module is registered', () => assert.match(app,/register\(merchantAccessRoutes\)/));
test('v0.6 CI includes merchant staff RBAC lifecycle', () => assert.match(read('.github/workflows/ci.yml'),/Merchant staff and RBAC lifecycle/));
test('v0.6 migration 007 is not introduced', () => assert.equal(existsSync('migrations/007_merchant_staff_rbac_management.sql'), false));

test('no TLS certificate bypass is shipped', () => {
  const all = [app, read('src/db/pool.js'), read('src/config.js')].join('\n');
  assert.doesNotMatch(all, /rejectUnauthorized\s*:\s*false/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
console.log(`${passed}/${tests.length} Luke Shop Backend v0.11.0 source regression checks passed`);
