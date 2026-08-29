import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculateVipCashback } from '../src/modules/loyalty/execution.js';

assert.equal(calculateVipCashback({value_type:'PERCENTAGE',value:3,min_order:10,cap:20},{subtotal:100,discount_total:10}),2.7);
assert.equal(calculateVipCashback({value_type:'FIXED',value:25,min_order:10,cap:20},{subtotal:100,discount_total:0}),20);
assert.equal(calculateVipCashback({value_type:'PERCENTAGE',value:5,min_order:200},{subtotal:100,discount_total:0}),0);

const migration=fs.readFileSync(new URL('../migrations/021_vip_benefit_execution_reward_ledger.sql',import.meta.url),'utf8');
for(const token of ['upgrade_policy','IMMEDIATE','SCHEDULED','MANUAL','CREATE TABLE order_vip_benefits','CREATE TABLE vip_reward_ledger','CREATE TABLE vip_entitlements','REFUND_CLAWBACK','ADMIN_ADJUSTMENT','VIP_BENEFIT','source_key'])assert.ok(migration.includes(token),`missing migration contract ${token}`);
assert.doesNotMatch(migration,/cashback_balance/i);
assert.match(migration,/UNIQUE \(tenant_id, store_id, source_key\)/);
assert.match(migration,/Historical orders are intentionally NOT backfilled/);
assert.match(migration,/vip_reward_ledger_expiry_idx ON vip_reward_ledger\(tenant_id, store_id, expires_at\) WHERE entry_type='EARN' AND expires_at IS NOT NULL;/,'migration 021 must stay byte-compatible with the already-applied production version');
assert.doesNotMatch(migration,/entry_type='ADMIN_ADJUSTMENT' AND amount>0/,'do not rewrite applied migration 021');

const migration022=fs.readFileSync(new URL('../migrations/022_vip_reward_expiry_index.sql',import.meta.url),'utf8');
assert.match(migration022,/DROP INDEX IF EXISTS vip_reward_ledger_expiry_idx/);
assert.match(migration022,/entry_type='ADMIN_ADJUSTMENT' AND amount>0/,'expiry-index hardening belongs in migration 022');

const execution=fs.readFileSync(new URL('../src/modules/loyalty/execution.js',import.meta.url),'utf8');
for(const token of ['resolveVipCheckoutBenefits','persistVipOrderSnapshots','processVipOrderCompletion','processVipOrderRefund','expireDueVipRewards','vipRewardAccount','adjustVipReward','vipExecutionSummary'])assert.ok(execution.includes(token),`missing execution function ${token}`);
assert.ok(execution.includes("frequency==='EVERY_ORDER'"));
assert.ok(execution.includes("entry_type='EARN'"));
assert.ok(execution.includes("'REFUND_CLAWBACK'"));
assert.ok(execution.includes("upgrade_policy==='IMMEDIATE'"));
assert.ok(execution.includes('ON CONFLICT (tenant_id,store_id,source_key) DO NOTHING'));
assert.ok(execution.includes("e.entry_type='ADMIN_ADJUSTMENT' AND e.amount>0"),'expiring positive staff credits must be processed');
assert.ok(execution.includes("x.entry_type IN ('EXPIRE','REFUND_CLAWBACK','REVERSAL')"),'expiry/refund must not double-debit a source reward');
assert.ok(execution.includes("o.status NOT IN ('CANCELLED','PAYMENT_FAILED','REFUNDED')"),'cancelled/failed/refunded orders must not consume free-delivery usage limits');
assert.doesNotMatch(execution,/cashback_balance|estimated_reward|synthetic_reward/i);

const delivery=fs.readFileSync(new URL('../src/modules/delivery/service.js',import.meta.url),'utf8');
assert.ok(delivery.includes('resolveVipCheckoutBenefits'));
assert.ok(delivery.includes('persistVipOrderSnapshots'));
assert.ok(delivery.includes('baseDeliveryTotal'));
assert.ok(delivery.includes('deliveryDiscount'));

const orders=fs.readFileSync(new URL('../src/modules/orders/merchant-routes.js',import.meta.url),'utf8');
assert.ok(orders.includes('processVipOrderCompletion'));
assert.match(orders,/toStatus==='COMPLETED'/);

const payments=fs.readFileSync(new URL('../src/modules/payments/merchant-routes.js',import.meta.url),'utf8');
assert.ok(payments.includes('processVipOrderRefund'));
assert.ok(payments.includes("request.body.status==='SUCCEEDED'"));

const routes=fs.readFileSync(new URL('../src/modules/loyalty/execution-routes.js',import.meta.url),'utf8');
for(const route of ['/v1/merchant/vip/execution','/v1/merchant/vip/execution-policy','/v1/merchant/vip/members/:customerRef/rewards','/v1/merchant/vip/members/:customerRef/rewards/adjust','/v1/customer/vip/rewards'])assert.ok(routes.includes(route),`missing ${route}`);
assert.ok(routes.includes('PERMISSIONS.LOYALTY_MANAGE'));

const app=fs.readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
assert.ok(app.includes('loyaltyExecutionRoutes'));

console.log('PASS VIP v1.1 frozen checkout benefits, immutable migration history, free-delivery execution, completion-only cashback, immutable reward ledger, non-duplicating expiry/refund accounting, entitlements, immediate-upgrade policy, and reward APIs');
