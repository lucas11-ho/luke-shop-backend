import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const migration=read('migrations/033_vip_cashback_redemption_engine_v1.sql');
const redemption=read('src/modules/loyalty/redemption.js');
const customerOrders=read('src/modules/orders/customer-routes.js');
const merchantOrders=read('src/modules/orders/merchant-routes.js');
const merchantPayments=read('src/modules/payments/merchant-routes.js');
const execution=read('src/modules/loyalty/execution.js');
const executionRoutes=read('src/modules/loyalty/execution-routes.js');
const expireOrders=read('src/scripts/expire-orders.js');
const zeroSettlement=read('src/modules/payments/zero-settlement.js');

assert.match(migration,/Additive migration\. Migrations 001-032 remain immutable/);
for(const token of ['VIP_REDEMPTION','REDEMPTION_RESTORE','CREATE TABLE vip_reward_redemptions','CREATE TABLE vip_reward_redemption_allocations','cashback_redemption_enabled','cashback_redemption_max_percent','cashback_redemption_min_amount'])assert.ok(migration.includes(token),`missing migration contract ${token}`);
assert.match(migration,/cashback_redemption_enabled boolean NOT NULL DEFAULT false/,'redemption must remain disabled by default');
assert.match(migration,/cashback_redemption_max_percent numeric\(5,2\) NOT NULL DEFAULT 100/);
assert.match(migration,/payment_refunds_amount_check CHECK \(amount >= 0\)/);

for(const token of ['vipCashbackRedemptionPolicy','applyVipCashbackRedemption','restoreVipCashbackRedemptionForOrder','vip_reward_redemption_allocations','FOR UPDATE','VIP_REDEMPTION_DISABLED','VIP_REDEMPTION_EXCEEDS_LIMIT','VIP_REWARD_BALANCE_INSUFFICIENT'])assert.ok(redemption.includes(token),`missing redemption contract ${token}`);
assert.match(redemption,/SELECT id FROM customers WHERE tenant_id=\$1 AND id=\$2 FOR UPDATE/,'customer lock must serialize concurrent redemptions');
assert.match(redemption,/ORDER BY e\.expires_at ASC NULLS LAST,e\.created_at,e\.id/,'earliest-expiring positive reward lots must be consumed first');
assert.match(redemption,/policyCap=money\(payable\*Math\.max\(0,Math\.min\(100,policy\.max_percent\)\)\/100\)/,'server must calculate merchant policy cap');
assert.doesNotMatch(redemption,/request\.body|localStorage|sessionStorage/,'redemption service must not trust browser state');

assert.match(customerOrders,/vip_cashback_amount:\{type:'number',minimum:0,maximum:1000000\}/);
for(const token of ['expireDueVipRewards','applyVipCashbackRedemption','VIP_REDEMPTION','createZeroValueRewardSettlement','consumeReservations','restoreVipCashbackRedemptionForOrder'])assert.ok(customerOrders.includes(token),`checkout missing ${token}`);
assert.match(customerOrders,/const fullyRewardPaid=Boolean\(redemption&&grandTotal===0\)/);
assert.match(customerOrders,/if\(fullyRewardPaid\).*createZeroValueRewardSettlement/s,'zero-payable checkout must use internal reward settlement');
assert.match(customerOrders,/else await createOrderPayment/,'external payment remains only for a positive remaining payable amount');

assert.match(zeroSettlement,/payment_method_id,status,amount,currency,paid_at,metadata/);
assert.match(zeroSettlement,/NULL,'PAID',0/);
assert.match(zeroSettlement,/VIP_CASHBACK_FULL_COVERAGE/);
assert.match(zeroSettlement,/external_charge:false/);
assert.doesNotMatch(zeroSettlement,/TokenPay|provider_key|fetch\(|https?:\/\//,'zero settlement must not call an external payment provider');

assert.ok(merchantOrders.includes('restoreVipCashbackRedemptionForOrder'));
assert.match(merchantOrders,/toStatus==='CANCELLED'.*restoreVipCashbackRedemptionForOrder/s);
assert.match(merchantOrders,/SELECT amount FROM vip_reward_redemptions/,'completion must read applied redemption amount');
assert.match(merchantOrders,/discount_total:money\(Number\(order\.discount_total\|\|0\)\+redemptionAmount\)/,'redeemed value must be excluded from fresh cashback earning basis');

assert.ok(expireOrders.includes('restoreVipCashbackRedemptionForOrder'));
assert.match(expireOrders,/restorationKey:`EXPIRE:\$\{order\.public_id\}`/);

assert.match(execution,/vip_reward_redemption_allocations/,'expiry must account for already allocated reward lots');
assert.match(execution,/remaining=money\(Math\.max\(0,Number\(entry\.amount\)-Number\(entry\.allocated_amount\|\|0\)\)\)/,'expiry must debit only the unspent remainder');
assert.match(execution,/restoreVipCashbackRedemptionForOrder/,'refund processing must restore checkout redemption');

for(const route of ['/v1/merchant/vip/redemption-policy','/v1/customer/vip/rewards'])assert.ok(executionRoutes.includes(route),`missing route ${route}`);
assert.match(executionRoutes,/app\.get\('\/v1\/merchant\/vip\/redemption-policy',\{preHandler:readGuard\(app\)\}/);
assert.match(executionRoutes,/app\.put\('\/v1\/merchant\/vip\/redemption-policy',\{preHandler:manageGuard\(app\)/);
assert.match(executionRoutes,/redemption_policy:await vipCashbackRedemptionPolicy/,'customer reward response must expose effective policy');

assert.match(merchantPayments,/p\.metadata\?\.settlement_type==='VIP_CASHBACK_FULL_COVERAGE'/,'zero-value refund requires internal reward settlement marker');
assert.match(merchantPayments,/vip_reward_redemptions WHERE tenant_id=\$1 AND store_id=\$2 AND order_id=\$3 AND status='APPLIED'/,'zero-value refund requires an active redemption');
assert.match(merchantPayments,/if\(!zeroRewardSettlement\)throw errors\.conflict\('PAYMENT_ALREADY_REFUNDED'/);
assert.match(merchantPayments,/processVipOrderRefund/);

for(const oldMigration of ['migrations/019_vip_loyalty_foundation.sql','migrations/021_vip_benefit_execution_reward_ledger.sql','migrations/022_vip_reward_expiry_index.sql']){
  const text=read(oldMigration);
  assert.doesNotMatch(text,/vip_reward_redemptions|cashback_redemption_enabled|REDEMPTION_RESTORE/,`${oldMigration} must remain historical and unmodified by redemption v1`);
}

console.log('PASS VIP Cashback Redemption v1 source/security guard: additive migration, server policy, locked lot allocation, zero external settlement, cancellation/refund restoration, partial expiry, and anti-recycling cashback basis');
