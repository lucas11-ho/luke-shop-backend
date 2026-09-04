import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { expireDueVipRewards } from '../src/modules/loyalty/execution.js';
import {
  applyVipCashbackRedemption,
  restoreVipCashbackRedemptionForOrder,
  vipCashbackAvailableBalance,
  vipCashbackRedemptionPolicy,
} from '../src/modules/loyalty/redemption.js';
import { createZeroValueRewardSettlement } from '../src/modules/payments/zero-settlement.js';

const db=createDatabase(loadConfig());
const suffix=randomUUID().replaceAll('-','').slice(0,10);
const ids={tenant:randomUUID(),store:randomUUID(),program:randomUUID()};
const refs={tenant:`tnt_vrd_${suffix}`,store:`str_vrd_${suffix}`,program:`vipg_vrd_${suffix}`};
const customerIds=[];

async function makeCustomer(label){
  const id=randomUUID();customerIds.push(id);
  await db.query(`INSERT INTO customers(id,public_id,tenant_id,display_name,status) VALUES($1,$2,$3,$4,'ACTIVE')`,[id,`cus_vrd_${label}_${suffix}`,ids.tenant,`VIP ${label}`]);
  return id;
}

async function makeOrder(customerId,label,total,{status='PENDING_PAYMENT',paymentStatus='PENDING'}={}){
  const id=randomUUID(),publicId=`ord_vrd_${label}_${suffix}`,orderNumber=`VRD-${label.toUpperCase()}-${suffix}`;
  await db.query(`INSERT INTO orders(id,public_id,order_number,tenant_id,store_id,customer_id,order_type,status,payment_status,currency,subtotal,discount_total,delivery_total,grand_total)
    VALUES($1,$2,$3,$4,$5,$6,'PHYSICAL',$7,$8,'USD',$9,0,0,$9)`,[id,publicId,orderNumber,ids.tenant,ids.store,customerId,status,paymentStatus,total]);
  return {id,publicId,orderNumber,total};
}

async function credit(customerId,label,amount,expiresAt=null){
  const id=randomUUID(),publicId=`vrl_vrd_${label}_${suffix}`;
  await db.query(`INSERT INTO vip_reward_ledger(id,public_id,tenant_id,store_id,customer_id,entry_type,amount,currency,source_key,description,expires_at)
    VALUES($1,$2,$3,$4,$5,'EARN',$6,'USD',$7,$8,$9)`,[id,publicId,ids.tenant,ids.store,customerId,amount,`TEST:${label}:${suffix}`,`Test reward ${label}`,expiresAt]);
  return {id,publicId,amount};
}

async function expectCode(promise,code){
  let caught=null;try{await promise;}catch(error){caught=error;}
  assert.ok(caught,`expected ${code}`);assert.equal(caught.code,code);
}

try{
  await db.transaction(async client=>{
    await client.query(`INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')`,[ids.tenant,refs.tenant,`vip-redemption-${suffix}`,`VIP Redemption ${suffix}`]);
    await client.query(`INSERT INTO tenant_settings(tenant_id,currency) VALUES($1,'USD')`,[ids.tenant]);
    await client.query(`INSERT INTO stores(id,public_id,tenant_id,slug,name,status,is_primary) VALUES($1,$2,$3,$4,$5,'ACTIVE',true)`,[ids.store,refs.store,ids.tenant,`vip-redemption-store-${suffix}`,`VIP Redemption Store ${suffix}`]);
    await client.query(`INSERT INTO vip_programs(id,public_id,tenant_id,store_id,enabled) VALUES($1,$2,$3,$4,true)`,[ids.program,refs.program,ids.tenant,ids.store]);
  });

  let policy=await vipCashbackRedemptionPolicy(db,{tenantId:ids.tenant,storeId:ids.store});
  assert.equal(policy.program_enabled,true);assert.equal(policy.cashback_redemption_enabled,false);assert.equal(policy.enabled,false,'redemption must default off after migration 033');

  const allocationCustomer=await makeCustomer('allocation');
  const soon=await credit(allocationCustomer,'soon',10,new Date(Date.now()+86400000));
  const later=await credit(allocationCustomer,'later',20,new Date(Date.now()+2*86400000));
  const allocationOrder=await makeOrder(allocationCustomer,'allocation',30);
  await expectCode(db.transaction(client=>applyVipCashbackRedemption(client,{tenantId:ids.tenant,storeId:ids.store,customerId:allocationCustomer,orderId:allocationOrder.id,orderPublicId:allocationOrder.publicId,currency:'USD',requestedAmount:5,maxAmount:30})),'VIP_REDEMPTION_DISABLED');

  await db.query(`UPDATE vip_programs SET cashback_redemption_enabled=true,cashback_redemption_max_percent=50,cashback_redemption_min_amount=5 WHERE id=$1`,[ids.program]);
  policy=await vipCashbackRedemptionPolicy(db,{tenantId:ids.tenant,storeId:ids.store});
  assert.deepEqual({enabled:policy.enabled,max:policy.max_percent,min:policy.min_amount},{enabled:true,max:50,min:5});

  const applied=await db.transaction(client=>applyVipCashbackRedemption(client,{tenantId:ids.tenant,storeId:ids.store,customerId:allocationCustomer,orderId:allocationOrder.id,orderPublicId:allocationOrder.publicId,currency:'USD',requestedAmount:15,maxAmount:30}));
  assert.equal(applied.amount,15);assert.equal(applied.max_authorized,15);assert.equal(applied.balance_before,30);assert.equal(applied.balance_after,15);
  assert.deepEqual(applied.allocations.map(item=>[item.source_entry_id,item.amount]),[[soon.publicId,10],[later.publicId,5]],'redemption must consume earliest-expiring reward lots first');
  assert.equal(await vipCashbackAvailableBalance(db,{tenantId:ids.tenant,storeId:ids.store,customerId:allocationCustomer,currency:'USD'}),15);

  const restored=await db.transaction(client=>restoreVipCashbackRedemptionForOrder(client,{tenantId:ids.tenant,storeId:ids.store,orderId:allocationOrder.id,restorationKey:`TEST:${allocationOrder.publicId}`,reason:'Lifecycle cancellation restore'}));
  assert.equal(restored.restored,true);assert.equal(restored.amount,15);
  assert.equal(await vipCashbackAvailableBalance(db,{tenantId:ids.tenant,storeId:ids.store,customerId:allocationCustomer,currency:'USD'}),30);
  const restoredAgain=await db.transaction(client=>restoreVipCashbackRedemptionForOrder(client,{tenantId:ids.tenant,storeId:ids.store,orderId:allocationOrder.id,restorationKey:`TEST:${allocationOrder.publicId}`,reason:'Duplicate restore'}));
  assert.equal(restoredAgain.restored,false);assert.equal(restoredAgain.amount,0,'restoration must be idempotent');

  const expiryCustomer=await makeCustomer('expiry');
  const expiring=await credit(expiryCustomer,'partial-expiry',20,new Date(Date.now()+86400000));
  const expiryOrder=await makeOrder(expiryCustomer,'expiry',20);
  const partial=await db.transaction(client=>applyVipCashbackRedemption(client,{tenantId:ids.tenant,storeId:ids.store,customerId:expiryCustomer,orderId:expiryOrder.id,orderPublicId:expiryOrder.publicId,currency:'USD',requestedAmount:5,maxAmount:20}));
  assert.equal(partial.amount,5);
  await db.query(`UPDATE vip_reward_ledger SET expires_at=now()-interval '1 minute' WHERE id=$1`,[expiring.id]);
  const expiredCount=await db.transaction(client=>expireDueVipRewards(client,{tenantId:ids.tenant,storeId:ids.store,customerId:expiryCustomer}));
  assert.equal(expiredCount,1);
  const expiryDebit=await db.query(`SELECT amount FROM vip_reward_ledger WHERE tenant_id=$1 AND store_id=$2 AND related_entry_id=$3 AND entry_type='EXPIRE'`,[ids.tenant,ids.store,expiring.id]);
  assert.equal(Number(expiryDebit.rows[0].amount),-15,'expiry must debit only the unspent reward remainder');
  assert.equal(await vipCashbackAvailableBalance(db,{tenantId:ids.tenant,storeId:ids.store,customerId:expiryCustomer,currency:'USD'}),0);

  const capCustomer=await makeCustomer('cap');
  await credit(capCustomer,'cap-credit',30,new Date(Date.now()+3*86400000));
  const capOrder=await makeOrder(capCustomer,'cap',30);
  await expectCode(db.transaction(client=>applyVipCashbackRedemption(client,{tenantId:ids.tenant,storeId:ids.store,customerId:capCustomer,orderId:capOrder.id,orderPublicId:capOrder.publicId,currency:'USD',requestedAmount:16,maxAmount:30})),'VIP_REDEMPTION_EXCEEDS_LIMIT');
  await expectCode(db.transaction(client=>applyVipCashbackRedemption(client,{tenantId:ids.tenant,storeId:ids.store,customerId:capCustomer,orderId:capOrder.id,orderPublicId:capOrder.publicId,currency:'USD',requestedAmount:4,maxAmount:30})),'VIP_REDEMPTION_MINIMUM_NOT_MET');
  assert.equal(await vipCashbackAvailableBalance(db,{tenantId:ids.tenant,storeId:ids.store,customerId:capCustomer,currency:'USD'}),30,'failed policy checks must not mutate rewards');

  const concurrentCustomer=await makeCustomer('concurrent');
  await credit(concurrentCustomer,'concurrent-credit',15,new Date(Date.now()+3*86400000));
  const concurrentA=await makeOrder(concurrentCustomer,'concurrent-a',20),concurrentB=await makeOrder(concurrentCustomer,'concurrent-b',20);
  const concurrent=await Promise.allSettled([
    db.transaction(client=>applyVipCashbackRedemption(client,{tenantId:ids.tenant,storeId:ids.store,customerId:concurrentCustomer,orderId:concurrentA.id,orderPublicId:concurrentA.publicId,currency:'USD',requestedAmount:10,maxAmount:20})),
    db.transaction(client=>applyVipCashbackRedemption(client,{tenantId:ids.tenant,storeId:ids.store,customerId:concurrentCustomer,orderId:concurrentB.id,orderPublicId:concurrentB.publicId,currency:'USD',requestedAmount:10,maxAmount:20})),
  ]);
  assert.equal(concurrent.filter(item=>item.status==='fulfilled').length,1,'only one concurrent redemption may spend the shared balance');
  assert.equal(concurrent.filter(item=>item.status==='rejected').length,1);
  assert.equal(concurrent.find(item=>item.status==='rejected').reason.code,'VIP_REWARD_BALANCE_INSUFFICIENT');
  const concurrentDebit=await db.query(`SELECT COALESCE(sum(amount),0)::numeric AS total FROM vip_reward_ledger WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND entry_type='REDEEM'`,[ids.tenant,ids.store,concurrentCustomer]);
  assert.equal(Number(concurrentDebit.rows[0].total),-10,'concurrent requests must not overspend the reward ledger');

  await db.query(`UPDATE vip_programs SET cashback_redemption_max_percent=100,cashback_redemption_min_amount=0 WHERE id=$1`,[ids.program]);
  const zeroCustomer=await makeCustomer('zero');
  await credit(zeroCustomer,'zero-credit',30,new Date(Date.now()+3*86400000));
  const zeroOrder=await makeOrder(zeroCustomer,'zero',30);
  const full=await db.transaction(client=>applyVipCashbackRedemption(client,{tenantId:ids.tenant,storeId:ids.store,customerId:zeroCustomer,orderId:zeroOrder.id,orderPublicId:zeroOrder.publicId,currency:'USD',requestedAmount:30,maxAmount:30}));
  assert.equal(full.amount,30);assert.equal(full.balance_after,0);
  await db.query(`UPDATE orders SET status='PAID',payment_status='PAID',paid_at=now(),reservation_expires_at=NULL WHERE id=$1`,[zeroOrder.id]);
  const settlement=await db.transaction(client=>createZeroValueRewardSettlement(client,{tenantId:ids.tenant,storeId:ids.store,orderId:zeroOrder.id,currency:'USD'}));
  assert.equal(Number(settlement.amount),0);assert.equal(settlement.status,'PAID');assert.equal(settlement.payment_method_id,null);assert.equal(settlement.metadata.settlement_type,'VIP_CASHBACK_FULL_COVERAGE');
  const attempt=await db.query(`SELECT status,request_summary FROM payment_attempts WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3`,[ids.tenant,ids.store,settlement.id]);
  assert.equal(attempt.rows[0].status,'SUCCEEDED');assert.equal(attempt.rows[0].request_summary.external_charge,false);

  const zeroRefundId=randomUUID();
  await db.query(`INSERT INTO payment_refunds(id,public_id,tenant_id,store_id,order_id,payment_id,status,amount,currency,reason,previous_order_status,previous_payment_status)
    VALUES($1,$2,$3,$4,$5,$6,'REQUESTED',0,'USD','Reward-only lifecycle refund','PAID','PAID')`,[zeroRefundId,`rfnd_vrd_${suffix}`,ids.tenant,ids.store,zeroOrder.id,settlement.id]);
  const zeroRefund=await db.query(`SELECT amount FROM payment_refunds WHERE id=$1`,[zeroRefundId]);
  assert.equal(Number(zeroRefund.rows[0].amount),0,'migration 033 must permit the guarded reward-only refund record');

  console.log('PASS VIP redemption defaults off and merchant policy limits are authoritative');
  console.log('PASS earliest-expiring reward lots allocate deterministically and restoration is idempotent');
  console.log('PASS partially spent reward lots expire only their unspent remainder');
  console.log('PASS customer row locking prevents concurrent cashback overspend');
  console.log('PASS fully reward-covered orders use a zero-value internal paid settlement and support audited zero-value refund records');
}finally{
  await db.query('DELETE FROM tenants WHERE id=$1',[ids.tenant]).catch(()=>{});
  await db.close().catch(()=>{});
}
