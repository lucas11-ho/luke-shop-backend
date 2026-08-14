import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const pkg = JSON.parse(read('package.json'));
const app = read('src/app.js');
const config = read('src/config.js');
const authPlugin = read('src/plugins/auth.js');
const merchant = read('src/modules/auth/merchant-routes.js');
const customer = read('src/modules/auth/customer-routes.js');
const ci = read('.github/workflows/ci.yml');
const migration = readFileSync('migrations/001_multi_tenant_commerce_foundation.sql');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('package version carries v0.1.1 auth repair forward', () => assert.ok(['0.1.1', '0.1.2', '0.2.0', '0.3.0','0.4.0','0.4.1','0.4.2','0.5.0','0.6.0','0.7.0','0.7.1','0.8.0','0.9.0','0.10.0'].includes(pkg.version)));
test('runtime release carries authentication reliability repair forward', () => assert.match(config, /(?:0\.1\.(?:1-authentication-reliability-repair|2-http-error-semantics-stabilization)|0\.2\.0-catalog-inventory-foundation|0\.3\.0-cart-checkout-orders-foundation|0\.4\.0-payments-delivery-promotions-foundation|0\.4\.1-runtime-integration-stabilization|0\.4\.2-commerce-runtime-reliability-repair|0\.5\.0-luke-cs-commerce-connector-ai-tool-gateway|0\.6\.0-merchant-staff-rbac-management|0\.7\.0-platform-control-plane-storefront-experience|0\.7\.1-multi-tenant-storefront-routing|0\.8\.0-media-asset-library|0\.9\.0-experience-commerce-workflow|0\.10\.0-store-designer-v3)/));
test('migration 001 is byte-for-byte unchanged from v0.1.0', () => assert.equal(createHash('sha256').update(migration).digest('hex'), '409325e42984e3d495a8af9b411cd3f01da610bef7cf6e2ce99bad563ccb2e19'));
test('migration 002, when present, is the later catalog release rather than an auth rewrite', () => { if (['0.2.0','0.3.0','0.4.0','0.4.1','0.4.2','0.5.0','0.6.0','0.7.0','0.7.1','0.8.0','0.9.0','0.10.0'].includes(pkg.version)) assert.equal(existsSync('migrations/002_catalog_inventory_foundation.sql'), true); });
test('auth guard stores database-verified customer identity and session IDs', () => assert.match(authPlugin, /actorId: result\.rows\[0\]\.id[\s\S]*sessionId: result\.rows\[0\]\.session_id/));
test('auth guard stores database-verified merchant identity and session IDs', () => assert.ok((authPlugin.match(/actorId: result\.rows\[0\]\.id/g) || []).length >= 2));
test('merchant logout revokes the verified database session in a transaction', () => { assert.match(merchant, /merchant\/auth\/logout[\s\S]*app\.db\.transaction/); assert.match(merchant, /WHERE tenant_id = \$1 AND id = \$2 AND revoked_at IS NULL/); assert.match(merchant, /request\.auth\.profile\.session_id/); });
test('customer logout revokes the verified database session in a transaction', () => { assert.match(customer, /customer\/auth\/logout[\s\S]*app\.db\.transaction/); assert.match(customer, /request\.auth\.profile\.session_id/); });
test('merchant refresh token rotation is row-locked', () => assert.match(merchant, /merchant_sessions[\s\S]*FOR UPDATE/));
test('customer refresh token rotation is row-locked', () => assert.match(customer, /customer_sessions[\s\S]*FOR UPDATE/));
test('merchant refresh and logout are audited', () => { assert.match(merchant, /merchant\.refresh/); assert.match(merchant, /merchant\.logout/); });
test('customer refresh and logout are audited', () => { assert.match(customer, /customer\.refresh/); assert.match(customer, /customer\.logout/); });
test('Fastify deprecated top-level disableRequestLogging option is removed', () => { assert.doesNotMatch(app, /^\s*disableRequestLogging:/m); assert.match(app, /new LogController\(\{ disableRequestLogging: config\.production \}\)/); });
test('live PostgreSQL auth lifecycle test exists', () => assert.match(pkg.scripts['test:auth-db'], /auth-lifecycle-test/));
test('CI runs live PostgreSQL authentication lifecycle', () => assert.match(ci, /Authentication lifecycle/));

let passed = 0;
for (const [name, fn] of tests) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
console.log(`${passed}/${tests.length} Luke Shop Backend v0.1.1 authentication reliability checks passed`);
