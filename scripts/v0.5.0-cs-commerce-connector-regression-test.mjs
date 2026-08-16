import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
const read=(p)=>readFileSync(p,'utf8').replace(/\r\n?/g,'\n'); const sha=(p)=>createHash('sha256').update(readFileSync(p,'utf8').replace(/\r\n?/g,'\n')).digest('hex');
const tests=[]; const test=(n,f)=>tests.push([n,f]);
const pkg=JSON.parse(read('package.json')); const migration=read('migrations/005_cs_commerce_connector_foundation.sql');
const auth=read('src/modules/integrations/customer-service/service-auth.js'); const policy=read('src/modules/integrations/customer-service/policy.js');
const ctx=read('src/modules/integrations/customer-service/context.js'); const ctxRoutes=read('src/modules/integrations/customer-service/customer-context-routes.js');
const tools=read('src/modules/integrations/customer-service/tool-routes.js'); const merchant=read('src/modules/integrations/customer-service/merchant-routes.js');
const service=read('src/modules/integrations/customer-service/service-routes.js'); const tokens=read('src/core/tokens.js'); const config=read('src/config.js'); const app=read('src/app.js');

test('package version carries v0.5.0 connector forward',()=>assert.ok(['0.5.0','0.6.0','0.7.0','0.7.1','0.8.0','0.9.0','0.10.0','0.11.0','0.11.1','0.12.0'].includes(pkg.version)));
test('runtime release carries v0.5.0 connector forward',()=>assert.match(config,/(0\.5\.0-luke-cs-commerce-connector-ai-tool-gateway|0\.6\.0-merchant-staff-rbac-management|0\.7\.0-platform-control-plane-storefront-experience|0\.7\.1-multi-tenant-storefront-routing|0\.8\.0-media-asset-library|0\.9\.0-experience-commerce-workflow|0\.10\.0-store-designer-v3|0\.11\.0-operations-control-completion|0\.11\.1-customer-experience-reliability|0\.12\.0-delivery-location-status-visuals)/));
for(const [file,hash] of Object.entries({
 'migrations/001_multi_tenant_commerce_foundation.sql':'409325e42984e3d495a8af9b411cd3f01da610bef7cf6e2ce99bad563ccb2e19',
 'migrations/002_catalog_inventory_foundation.sql':'9199f9ff88a6aec27ef07cfa4e691133ffa8cd60376c8bba2afe6f4dfc150c97',
 'migrations/003_cart_checkout_orders_foundation.sql':'5eb19b228976135dff6dd17c1cee60e48b8388f1b6b9960a498f1b3c29fa73ed',
 'migrations/004_payments_delivery_promotions_foundation.sql':'d471cada84320666ee496ac1b725b38c87dec1d0b1d7a48b6d138a8b03abdf42',
})) test(`${file.split('/').pop()} normalized content remains immutable`,()=>assert.equal(sha(file),hash));
for(const table of ['customer_service_policies','customer_service_contexts','customer_service_request_nonces','customer_service_tool_calls']) test(`005 creates ${table}`,()=>assert.match(migration,new RegExp(`CREATE TABLE ${table}\\b`)));
test('005 gives integration clients explicit STAFF or AI usage mode',()=>{assert.match(migration,/ADD COLUMN usage_mode/);assert.match(migration,/'STAFF','AI'/);});
test('existing integration clients remain STAFF by default',()=>assert.match(migration,/DEFAULT 'STAFF'/));
test('tenant policy has separate general and AI controls',()=>{for(const key of ['customer_read','product_read','orders_read','payments_read','delivery_read','ai_customer_read','ai_product_read','ai_orders_read','ai_payments_read','ai_delivery_read'])assert.match(migration,new RegExp(`\\b${key}\\b`));});
test('AI policy defaults remain off',()=>{for(const key of ['ai_customer_read','ai_product_read','ai_orders_read','ai_payments_read','ai_delivery_read'])assert.match(migration,new RegExp(`${key} boolean NOT NULL DEFAULT false`));});
test('support contexts bind tenant customer session and store',()=>{for(const key of ['tenant_id','customer_id','customer_session_id','store_id','allowed_tools','jti'])assert.match(migration,new RegExp(`\\b${key}\\b`));});
test('context checks live customer session and store status',()=>{assert.match(ctx,/cs\.revoked_at IS NULL/);assert.match(ctx,/c\.status='ACTIVE'/);assert.match(ctx,/s\.status='ACTIVE'/);});
test('customer context route requires authenticated customer',()=>assert.match(ctxRoutes,/requireCustomerAuth/));
test('support context JWT has dedicated audience',()=>assert.match(tokens,/luke-shop-cs-context/));
test('signed service JWT has dedicated audience',()=>assert.match(tokens,/luke-shop-cs-service/));
test('production context signing secret is separate',()=>assert.match(config,/CS_CONTEXT_SIGNING_SECRET/));
test('service signing secret is separately configurable and distinct in production',()=>{assert.match(config,/CS_SERVICE_SIGNING_SECRET/);assert.match(config,/must be different in production/);assert.match(tokens,/csServiceSigningSecret/);});
test('service token exchange endpoint exists',()=>assert.match(service,/\/v1\/customer-service\/auth\/token/));
test('signed service token cannot mint another service token',()=>assert.match(service,/SERVICE_CREDENTIAL_REQUIRED/));
test('AI credentials cannot bypass signed context through legacy routes',()=>assert.match(auth,/AI_TOOL_GATEWAY_REQUIRED/));
test('tool gateway requires short-lived signed service token',()=>{assert.match(auth,/requireSignedCustomerServiceToken/);assert.match(tools,/requireSignedCustomerServiceToken/);assert.match(auth,/SERVICE_SIGNED_TOKEN_REQUIRED/);});
test('tool requests require signed context, timestamp, and nonce',()=>{assert.match(tools,/requireFreshCustomerServiceRequest/);assert.match(tools,/requireCustomerServiceContext/);assert.match(ctx,/x-luke-request-timestamp/);assert.match(ctx,/x-luke-request-nonce/);});
test('request nonce stores a hash not raw nonce',()=>{assert.match(ctx,/hashRequestNonce/);assert.match(migration,/nonce_hash char\(64\)/);assert.doesNotMatch(migration,/\bnonce text\b/);});
test('reused nonce is rejected',()=>assert.match(ctx,/SERVICE_REQUEST_REPLAYED/));
test('tool gateway has exact eight read-only tools',()=>{for(const name of ['customer.get','product.search','product.get','orders.list','order.get','order.status','payment.status','delivery.status'])assert.match(policy,new RegExp(name.replace('.','\\.')));assert.doesNotMatch(policy,/(cancel_order|refund_order|change_address|change_payment|change_delivery|customer\.update)/);});
test('tool gateway enforces service scope',()=>assert.match(tools,/SERVICE_SCOPE_REQUIRED/));
test('tool gateway enforces signed-context tool allowlist',()=>assert.match(tools,/SUPPORT_CONTEXT_TOOL_DENIED/));
test('tool gateway enforces tenant and AI policy',()=>assert.match(tools,/isToolAllowed\(policy,request\.serviceAuth\.usageMode,tool\)/));
test('merchant can manage general and AI policy separately',()=>{assert.match(merchant,/ai_access/);assert.match(merchant,/\/policy/);});
test('merchant credentials declare STAFF or AI usage mode',()=>assert.match(merchant,/usage_mode/));
test('tool calls are durably audited without full result payload',()=>{assert.match(tools,/customer_service_tool_calls/);assert.match(migration,/result_code text NOT NULL/);assert.doesNotMatch(migration,/result_payload|response_payload/);});
test('customer/payment/delivery tool responses avoid provider secrets and tracking URL',()=>{assert.doesNotMatch(tools,/provider_reference:payment/);assert.doesNotMatch(tools,/tracking_url:row/);});
test('tool calls use customer from signed context, not arbitrary customer argument',()=>{assert.match(tools,/request\.supportContext\.customer_id/);assert.doesNotMatch(tools,/args\.customer_id/);});
test('order payment and delivery tools enforce context store binding',()=>{assert.match(tools,/assertOrderInContext/);assert.match(tools,/store_id=\$2 AND customer_id=\$3/);});
test('new connector routes are registered',()=>{assert.match(app,/register\(customerSupportContextRoutes\)/);assert.match(app,/register\(customerServiceToolRoutes\)/);});
test('bootstrap creates a default CS policy through provisioning',()=>{assert.match(read('src/scripts/bootstrap-tenant.js'),/provisionTenant/);assert.match(read('src/modules/platform/provisioning.js'),/ensureCustomerServicePolicy/);});
test('cleanup maintenance exists',()=>assert.equal(existsSync('src/scripts/cleanup-cs-contexts.js'),true));
test('CI runs live Luke CS connector lifecycle',()=>assert.match(read('.github/workflows/ci.yml'),/Luke CS Commerce Connector lifecycle/));
test('v0.5 adds migration 005 and no migration 006',()=>{assert.ok(existsSync('migrations/005_cs_commerce_connector_foundation.sql'));assert.equal(existsSync('migrations/006_cs_commerce_connector_foundation.sql'),false);});
let passed=0;for(const [n,f] of tests){try{f();passed++;console.log(`PASS ${n}`);}catch(e){console.error(`FAIL ${n}`);throw e;}}console.log(`${passed}/${tests.length} Luke Shop Backend v0.5.0 CS commerce connector checks passed`);
