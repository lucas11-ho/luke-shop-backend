import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertProductFulfillmentCompatibility, allowedFulfillmentModesForProductType,
} from '../src/modules/catalog/product-policy.js';
import { fulfillmentTypeFor } from '../src/modules/delivery/service.js';
import { createDigitalContentToken, verifyDigitalContentToken } from '../src/modules/digital-delivery/service.js';

assert.deepEqual(allowedFulfillmentModesForProductType('FOOD'),['LOCAL_DELIVERY','PICKUP']);
assert.deepEqual(allowedFulfillmentModesForProductType('DIGITAL_IMAGE'),['DIGITAL_ACCESS','DIGITAL_DOWNLOAD']);
assert.equal(fulfillmentTypeFor('DIGITAL_IMAGE','DIGITAL_ACCESS'),'DIGITAL_ACCESS');
assert.equal(fulfillmentTypeFor('DIGITAL_VIDEO','DIGITAL_DOWNLOAD'),'DIGITAL_DOWNLOAD');
assert.throws(()=>assertProductFulfillmentCompatibility('FOOD',['DIGITAL_ACCESS']),error=>error?.code==='PRODUCT_FULFILLMENT_INCOMPATIBLE');
assert.throws(()=>assertProductFulfillmentCompatibility('DIGITAL_IMAGE',['LOCAL_DELIVERY']),error=>error?.code==='PRODUCT_FULFILLMENT_INCOMPATIBLE');

const secret='s'.repeat(64);
const token=createDigitalContentToken(secret,{entitlementId:'dent_test',assetId:'ast_test',mode:'VIEW',ttlSeconds:60});
assert.equal(verifyDigitalContentToken(secret,token,{entitlementId:'dent_test',assetId:'ast_test'}).m,'VIEW');
assert.throws(()=>verifyDigitalContentToken(secret,token,{entitlementId:'dent_other',assetId:'ast_test'}));
assert.throws(()=>verifyDigitalContentToken('x'.repeat(64),token,{entitlementId:'dent_test',assetId:'ast_test'}));

const migration=await readFile(new URL('../migrations/023_product_policy_digital_entitlements.sql',import.meta.url),'utf8');
const digitalService=await readFile(new URL('../src/modules/digital-delivery/service.js',import.meta.url),'utf8');
const digitalRoutes=await readFile(new URL('../src/modules/digital-delivery/routes.js',import.meta.url),'utf8');
const delivery=await readFile(new URL('../src/modules/delivery/service.js',import.meta.url),'utf8');

for(const needle of [
  'product_fulfillment_policy_guard','product_digital_policies','order_digital_entitlements',
  "status IN ('PENDING','ACTIVE','REVOKED')",'order_digital_entitlement_assets','digital_access_events',
]) assert.ok(migration.includes(needle),`migration missing ${needle}`);

for(const needle of [
  "payment_status='PAID'","status='REVOKED'",'DIGITAL_DOWNLOAD_NOT_ALLOWED','DIGITAL_DOWNLOAD_LIMIT_REACHED',
  'timingSafeEqual','order_digital_entitlement_assets',
]) assert.ok(digitalService.includes(needle),`digital service missing ${needle}`);

for(const needle of [
  '/v1/customer/library','/v1/digital/content/','private, no-store','Content-Disposition',
  '/v1/merchant/products/:productId/digital-policy','VIEW_AND_DOWNLOAD',
]) assert.ok(digitalRoutes.includes(needle),`digital routes missing ${needle}`);

assert.ok(delivery.includes("productType==='DIGITAL_IMAGE'||productType==='DIGITAL_VIDEO'"),'digital product fulfillment mapping must use real product types');
assert.ok(delivery.includes('prepareOrderDigitalEntitlements'),'checkout fulfillment creation must freeze digital entitlements');

console.log('Product policy + digital entitlement regression checks passed.');
