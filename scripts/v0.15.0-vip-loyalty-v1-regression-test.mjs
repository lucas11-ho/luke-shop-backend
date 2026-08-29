import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bestQualifiedLevel, levelQualifies, normalizeBenefitConfig, validateVipLevel, vipPeriodWindow } from '../src/modules/loyalty/service.js';

const now=new Date('2026-08-29T12:00:00.000Z');
assert.equal(vipPeriodWindow({evaluation_period:'LIFETIME'},now).start,null);
assert.equal(vipPeriodWindow({evaluation_period:'ROLLING_30'},now).start,'2026-07-30T12:00:00.000Z');
assert.equal(vipPeriodWindow({evaluation_period:'CALENDAR_YEAR'},now).start,'2026-01-01T00:00:00.000Z');
assert.equal(vipPeriodWindow({evaluation_period:'CUSTOM',custom_period_days:7},now).start,'2026-08-22T12:00:00.000Z');

const metrics={qualified_spend:1000,qualified_orders:25};
const levels=[
 {id:'bronze',qualification_mode:'SPEND',spend_threshold:0,order_threshold:null,sort_order:0,created_at:'2026-01-01'},
 {id:'silver',qualification_mode:'OR',spend_threshold:500,order_threshold:15,sort_order:10,created_at:'2026-01-01'},
 {id:'gold',qualification_mode:'AND',spend_threshold:1000,order_threshold:25,sort_order:20,created_at:'2026-01-01'},
];
assert.equal(levelQualifies(levels[2],metrics),true);
assert.equal(bestQualifiedLevel(levels,metrics).id,'gold');
assert.equal(bestQualifiedLevel(levels,{qualified_spend:600,qualified_orders:2}).id,'silver');
assert.equal(validateVipLevel({qualification_mode:'SPEND',spend_threshold:100}).spend_threshold,100);
assert.throws(()=>validateVipLevel({qualification_mode:'AND',spend_threshold:100}),/Spend and order thresholds/);

assert.deepEqual(normalizeBenefitConfig('FREE_DELIVERY',{min_order:20,max_subsidy:5,usage_limit:3,delivery_method_ids:['a','a','b']}),{min_order:20,max_subsidy:5,usage_limit:3,delivery_method_ids:['a','b']});
assert.deepEqual(normalizeBenefitConfig('CASHBACK',{value_type:'PERCENTAGE',value:3,min_order:10,cap:20,expires_days:30}),{value_type:'PERCENTAGE',value:3,min_order:10,cap:20,expires_days:30});
assert.throws(()=>normalizeBenefitConfig('CASHBACK',{value_type:'PERCENTAGE',value:120}),/Cashback value is invalid/);

const migration=fs.readFileSync(new URL('../migrations/019_vip_loyalty_foundation.sql',import.meta.url),'utf8');
for(const token of ['loyalty.read','loyalty.manage','CREATE TABLE vip_programs','CREATE TABLE vip_levels','CREATE TABLE vip_benefits','CREATE TABLE customer_vip_status','CREATE TABLE vip_tier_history']) assert.match(migration,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
const rbacBackfill=fs.readFileSync(new URL('../migrations/020_vip_loyalty_rbac_backfill.sql',import.meta.url),'utf8');
for(const token of ['customers.read','customers.status.manage','tenant.settings.write','loyalty.read','loyalty.manage','ON CONFLICT DO NOTHING']) assert.match(rbacBackfill,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
assert.match(rbacBackfill,/tenant_admin\.role_id\s*=\s*customer_admin\.role_id/);
assert.match(rbacBackfill,/customer_admin\.permission_key\s*=\s*'customers\.status\.manage'/);
assert.match(rbacBackfill,/tenant_admin\.permission_key\s*=\s*'tenant\.settings\.write'/);
const merchant=fs.readFileSync(new URL('../src/modules/loyalty/merchant-routes.js',import.meta.url),'utf8');
for(const route of ['/v1/merchant/vip/program','/v1/merchant/vip/overview','/v1/merchant/vip/levels','/v1/merchant/vip/benefits','/v1/merchant/vip/members','/v1/merchant/vip/evaluate']) assert.ok(merchant.includes(route));
const service=fs.readFileSync(new URL('../src/modules/loyalty/service.js',import.meta.url),'utf8');
assert.match(service,/refunded_amount/);
assert.match(service,/to_status='COMPLETED'/);
assert.doesNotMatch(service,/cashback_balance|synthetic|estimated_value/i);
const customer=fs.readFileSync(new URL('../src/modules/loyalty/customer-routes.js',import.meta.url),'utf8');
assert.ok(customer.includes('/v1/customer/vip'));

console.log('PASS VIP program periods, tier qualification, bounded benefits, legacy-role RBAC backfill, refund-aware completed-order metrics, merchant APIs, and customer VIP contract');
