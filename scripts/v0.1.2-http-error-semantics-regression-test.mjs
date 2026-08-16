import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const app = read('src/app.js');
const errors = read('src/core/errors.js');
const config = read('src/config.js');
const pkg = JSON.parse(read('package.json'));
const migration = read('migrations/001_multi_tenant_commerce_foundation.sql');

const tests = [
  ['package version carries v0.1.2 semantics forward', () => assert.ok(['0.1.2','0.2.0','0.3.0','0.4.0','0.4.1','0.4.2','0.5.0','0.6.0','0.7.0','0.7.1','0.8.0','0.9.0','0.10.0','0.11.0','0.11.1','0.12.0','0.13.0','0.14.0'].includes(pkg.version))],
  ['release marker carries v0.1.2 HTTP semantics forward', () => assert.match(config, /(?:0\.1\.2-http-error-semantics-stabilization|0\.2\.0-catalog-inventory-foundation|0\.3\.0-cart-checkout-orders-foundation|0\.4\.0-payments-delivery-promotions-foundation|0\.4\.1-runtime-integration-stabilization|0\.4\.2-commerce-runtime-reliability-repair|0\.5\.0-luke-cs-commerce-connector-ai-tool-gateway|0\.6\.0-merchant-staff-rbac-management|0\.7\.0-platform-control-plane-storefront-experience|0\.7\.1-multi-tenant-storefront-routing|0\.8\.0-media-asset-library|0\.9\.0-experience-commerce-workflow|0\.10\.0-store-designer-v3|0\.11\.0-operations-control-completion|0\.11\.1-customer-experience-reliability|0\.12\.0-delivery-location-status-visuals|0\.13\.0-identity-fulfillment-notifications)/)],
  ['migration 001 remains present', () => assert.match(migration, /CREATE TABLE tenants\b/)],
  ['global handler normalizes framework 4xx errors', () => assert.match(app, /normalizeHttpClientError\(error\)/)],
  ['normalized 4xx status is preserved', () => assert.match(app, /reply\.code\(clientError\.statusCode\)/)],
  ['unknown routes use structured 404 handling', () => assert.match(app, /setNotFoundHandler/)],
  ['unknown routes expose ROUTE_NOT_FOUND', () => assert.match(app, /ROUTE_NOT_FOUND/)],
  ['unsupported content type maps to 415 semantics', () => assert.match(errors, /FST_ERR_CTP_INVALID_MEDIA_TYPE[\s\S]*UNSUPPORTED_MEDIA_TYPE/)],
  ['invalid JSON maps to 400 semantics', () => assert.match(errors, /FST_ERR_CTP_INVALID_JSON_BODY[\s\S]*INVALID_JSON/)],
  ['payload too large maps to 413 semantics', () => assert.match(errors, /PAYLOAD_TOO_LARGE/)],
  ['rate limiting maps to 429 semantics', () => assert.match(errors, /\[429, \['RATE_LIMITED'/)],
  ['client-error normalizer rejects 5xx errors', () => assert.match(errors, /statusCode >= 500\) return null/)],
  ['unexpected errors still map to INTERNAL_ERROR 500', () => assert.match(app, /reply\.code\(500\).*INTERNAL_ERROR/s)],
  ['AppError handling stays ahead of framework normalization', () => assert.ok(app.indexOf('error instanceof AppError') < app.indexOf('normalizeHttpClientError(error)'))],
  ['validation errors still keep the stable validation envelope', () => assert.match(app, /VALIDATION_ERROR/)],
  ['PostgreSQL uniqueness errors still map to conflict', () => assert.match(app, /error\.code === '23505'[\s\S]*reply\.code\(409\)/)],
];

let passed = 0;
for (const [name, fn] of tests) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
console.log(`${passed}/${tests.length} Luke Shop Backend v0.1.2 HTTP error semantics checks passed`);
