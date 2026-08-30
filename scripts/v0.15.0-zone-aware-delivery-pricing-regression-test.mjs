import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{deliveryZoneMatchesAddress,haversineDistanceKm}from'../src/modules/delivery/service.js';

const migration=await readFile(new URL('../migrations/026_zone_aware_delivery_pricing.sql',import.meta.url),'utf8');
const delivery=await readFile(new URL('../src/modules/delivery/service.js',import.meta.url),'utf8');
const merchant=await readFile(new URL('../src/modules/delivery/merchant-routes.js',import.meta.url),'utf8');
const customer=await readFile(new URL('../src/modules/commerce/customer-routes.js',import.meta.url),'utf8');
const checkout=await readFile(new URL('../src/modules/orders/customer-routes.js',import.meta.url),'utf8');
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));

assert.ok(migration.includes("pricing_mode text NOT NULL DEFAULT 'BASELINE'"),'existing delivery methods must remain BASELINE by default');
assert.ok(migration.includes("pricing_mode IN ('BASELINE','ZONE_AWARE')"));
assert.ok(migration.includes("zone_no_match_policy IN ('UNAVAILABLE','BASELINE_FALLBACK')"));
assert.ok(!/UPDATE\s+delivery_methods\s+SET\s+pricing_mode\s*=\s*'ZONE_AWARE'/i.test(migration),'migration must never silently activate zone pricing');
assert.ok(migration.includes('delivery_pricing_snapshot jsonb'),'order fulfillments must freeze their pricing decision');
assert.ok(migration.includes('delivery_zone_rate_id uuid'));

const countryZone={match_type:'COUNTRY_REGION',country_codes:['KH'],region_names:[]};
assert.equal(deliveryZoneMatchesAddress(countryZone,{country_code:'KH',city:'Phnom Penh'}),true);
assert.equal(deliveryZoneMatchesAddress(countryZone,{country_code:'TH',city:'Bangkok'}),false);
const regionZone={match_type:'COUNTRY_REGION',country_codes:['KH'],region_names:['Phnom Penh','Kandal']};
assert.equal(deliveryZoneMatchesAddress(regionZone,{country_code:'KH',city:'phnom penh'}),true);
assert.equal(deliveryZoneMatchesAddress(regionZone,{country_code:'KH',city:'Siem Reap'}),false);
const radiusZone={match_type:'RADIUS',center_latitude:11.5564,center_longitude:104.9282,radius_km:5};
assert.equal(deliveryZoneMatchesAddress(radiusZone,{latitude:11.5564,longitude:104.9282}),true);
assert.equal(deliveryZoneMatchesAddress(radiusZone,{latitude:11.65,longitude:104.95}),false);
assert.equal(deliveryZoneMatchesAddress({match_type:'RADIUS',center_latitude:0,center_longitude:0,radius_km:5},{latitude:null,longitude:null}),false,'missing coordinates must never coerce to 0,0');
assert.ok(haversineDistanceKm(11.5564,104.9282,11.5564,104.9282)<0.001);
assert.equal(haversineDistanceKm(null,null,0,0),Infinity);

assert.ok(merchant.includes("/pricing-policy"),'merchant pricing policy API missing');
assert.ok(merchant.includes("DELIVERY_ZONE_RATE_REQUIRED"),'zone-aware activation must require an active zone rate');
assert.ok(merchant.includes("['SHIPPING','LOCAL_DELIVERY'].includes(method.fulfillment_mode)"),'Pickup must not support zone-aware pricing');
assert.ok(customer.includes("/v1/customer/delivery/quote"),'server-authoritative customer delivery quote endpoint missing');
assert.ok(customer.includes('pricing_mode,zone_no_match_policy'),'storefront delivery-method contract must disclose pricing mode');
assert.ok(checkout.includes('shippingAddress:request.body.shipping_address||null'),'checkout must resolve pricing from its own submitted address');
assert.ok(delivery.includes("pricing_source:source"),'frozen snapshot must record the resolver-selected pricing source');
assert.ok(delivery.includes("source:'ZONE_RATE'"),'matched zone pricing must explicitly mark ZONE_RATE as its snapshot source');
assert.ok(delivery.includes("source:'BASELINE_FALLBACK'"),'explicit unmatched fallback must be distinguishable from ordinary baseline pricing');
assert.ok(delivery.includes("DELIVERY_ZONE_UNAVAILABLE"));
assert.ok(delivery.includes('delivery_zone_id,delivery_zone_rate_id,delivery_pricing_snapshot'),'fulfillment insert must freeze zone/rate and pricing snapshot');
assert.ok(delivery.indexOf('zoneAwareAmount(client')<delivery.indexOf('resolveVipCheckoutBenefits(client'),'VIP free-delivery must apply after the server resolves baseline/zone delivery fee');
assert.equal(pkg.scripts['test:zone-aware-delivery-pricing'],'node scripts/v0.15.0-zone-aware-delivery-pricing-regression-test.mjs');
assert.ok(pkg.scripts.verify.includes('test:zone-aware-delivery-pricing'));
console.log('Zone-aware Delivery Pricing v1 regression checks passed.');
