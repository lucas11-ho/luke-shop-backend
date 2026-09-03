import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { evaluateCustomerVip } from './service.js';
import { restoreVipCashbackRedemptionForOrder } from './redemption.js';

const money=value=>Number(Number(value||0).toFixed(4));
const json=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const nowPlusDays=(days,now=new Date())=>Number(days)>0?new Date(now.getTime()+Number(days)*86400000):null;

export function calculateVipCashback(config={},order={}){
  const c=json(config);const base=money(Math.max(0,Number(order.subtotal||0)-Number(order.discount_total||0)));
  if(base<Number(c.min_order||0))return 0;
  let amount=(c.value_type||'PERCENTAGE')==='FIXED'?Number(c.value||0):base*Number(c.value||0)/100;
  if(c.cap!==null&&c.cap!==undefined&&c.cap!=='')amount=Math.min(amount,Number(c.cap));
  return money(Math.max(0,amount));
}

async function customerVipContext(client,{tenantId,storeId,customerId}){
  const row=await client.query(`SELECT vp.enabled,vp.upgrade_policy,ts.currency,cvs.level_id,l.public_id AS level_public_id,l.name AS level_name,l.code AS level_code,l.badge_color
    FROM vip_programs vp
    JOIN tenant_settings ts ON ts.tenant_id=vp.tenant_id
    LEFT JOIN customer_vip_status cvs ON cvs.tenant_id=vp.tenant_id AND cvs.store_id=vp.store_id AND cvs.customer_id=$3
    LEFT JOIN vip_levels l ON l.id=cvs.level_id AND l.tenant_id=cvs.tenant_id AND l.store_id=cvs.store_id AND l.status='ACTIVE'
    WHERE vp.tenant_id=$1 AND vp.store_id=$2`,[tenantId,storeId,customerId]);
  if(!row.rowCount||!row.rows[0].enabled||!row.rows[0].level_id||!row.rows[0].level_public_id)return null;
  const context=row.rows[0];
  const benefits=await client.query(`SELECT id AS internal_id,public_id AS id,name,benefit_type,frequency,config,sort_order
    FROM vip_benefits WHERE tenant_id=$1 AND store_id=$2 AND level_id=$3 AND status='ACTIVE' ORDER BY sort_order,created_at,id`,[tenantId,storeId,context.level_id]);
  return {...context,benefits:benefits.rows};
}

export async function resolveVipCheckoutBenefits(client,{tenantId,storeId,customerId,subtotal,deliveryMethod=null,deliveryAmount=0}){
  const context=await customerVipContext(client,{tenantId,storeId,customerId});
  if(!context)return {enabled:false,deliveryDiscount:0,snapshots:[]};
  const snapshots=[];const free=[];
  for(const benefit of context.benefits.filter(item=>item.frequency==='EVERY_ORDER')){
    const config=json(benefit.config);let eligible=true;let reason=null;
    if(['FREE_DELIVERY','CASHBACK','VOUCHER'].includes(benefit.benefit_type)&&Number(subtotal)<Number(config.min_order||0)){eligible=false;reason='Minimum order not met';}
    if(benefit.benefit_type==='FREE_DELIVERY'&&eligible){
      const methods=Array.isArray(config.delivery_method_ids)?config.delivery_method_ids.map(String):[];
      if(methods.length&&(!deliveryMethod||!methods.includes(String(deliveryMethod.public_id)))){eligible=false;reason='Delivery method is not eligible';}
      if(eligible&&Number(config.usage_limit)>0){
        const used=await client.query(`SELECT count(*)::int AS count FROM order_vip_benefits ovb
          JOIN orders o ON o.tenant_id=ovb.tenant_id AND o.store_id=ovb.store_id AND o.id=ovb.order_id
          WHERE ovb.tenant_id=$1 AND ovb.store_id=$2 AND ovb.customer_id=$3 AND ovb.benefit_id=$4 AND ovb.status='APPLIED'
            AND o.status NOT IN ('CANCELLED','PAYMENT_FAILED','REFUNDED')`,[tenantId,storeId,customerId,benefit.internal_id]);
        if(Number(used.rows[0]?.count||0)>=Number(config.usage_limit)){eligible=false;reason='Benefit usage limit reached';}
      }
      if(eligible){const cap=config.max_subsidy===null||config.max_subsidy===undefined||config.max_subsidy===''?Number(deliveryAmount):Number(config.max_subsidy);const amount=money(Math.min(Number(deliveryAmount||0),Math.max(0,cap)));free.push({benefit,config,amount});}
    }
    if(benefit.benefit_type!=='FREE_DELIVERY'&&eligible)snapshots.push({benefit,config,status:'SNAPSHOT',amount:0,reason:null});
    else if(benefit.benefit_type==='FREE_DELIVERY'&&!eligible)snapshots.push({benefit,config,status:'SKIPPED',amount:0,reason});
  }
  free.sort((a,b)=>b.amount-a.amount||Number(a.benefit.sort_order)-Number(b.benefit.sort_order));
  const selected=free[0]||null;
  for(const item of free)snapshots.push({benefit:item.benefit,config:item.config,status:item===selected&&item.amount>0?'APPLIED':'SKIPPED',amount:item===selected?item.amount:0,reason:item===selected?(item.amount>0?'VIP free delivery applied':'No delivery charge to subsidize'):'A higher-priority free-delivery benefit was applied'});
  return {enabled:true,currency:context.currency,level_id:context.level_id,level_public_id:context.level_public_id,level_name:context.level_name,deliveryDiscount:selected?.amount||0,snapshots};
}

export async function persistVipOrderSnapshots(client,{tenantId,storeId,orderId,deliverySelection}){
  const vip=deliverySelection?.vip;if(!vip?.enabled||!Array.isArray(vip.snapshots)||!vip.snapshots.length)return [];
  const order=(await client.query(`SELECT customer_id,currency FROM orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tenantId,storeId,orderId])).rows[0];
  if(!order)return [];
  const created=[];
  for(const snapshot of vip.snapshots){
    const result=await client.query(`INSERT INTO order_vip_benefits(id,public_id,tenant_id,store_id,order_id,customer_id,level_id,benefit_id,benefit_type,frequency,status,config_snapshot,amount,currency,reason,executed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,CASE WHEN $11 IN ('APPLIED','SKIPPED') THEN now() ELSE NULL END)
      ON CONFLICT (tenant_id,store_id,order_id,benefit_id) DO NOTHING RETURNING public_id`,[uuid(),publicId('ovip'),tenantId,storeId,orderId,order.customer_id,vip.level_id,snapshot.benefit.internal_id,snapshot.benefit.benefit_type,snapshot.benefit.frequency,snapshot.status,JSON.stringify(snapshot.config||{}),money(snapshot.amount),order.currency,snapshot.reason||null]);
    if(result.rowCount)created.push(result.rows[0].public_id);
  }
  return created;
}

export async function expireDueVipRewards(client,{tenantId,storeId,customerId=null}){
  const values=[tenantId,storeId];let customer='';if(customerId){values.push(customerId);customer=` AND e.customer_id=$${values.length}`;}
  const due=await client.query(`SELECT e.*,
      COALESCE((SELECT sum(a.amount) FROM vip_reward_redemption_allocations a WHERE a.tenant_id=e.tenant_id AND a.store_id=e.store_id AND a.source_ledger_entry_id=e.id),0)::numeric AS allocated_amount
    FROM vip_reward_ledger e WHERE e.tenant_id=$1 AND e.store_id=$2${customer}
    AND (e.entry_type IN ('EARN','REDEMPTION_RESTORE') OR (e.entry_type='ADMIN_ADJUSTMENT' AND e.amount>0)) AND e.expires_at IS NOT NULL AND e.expires_at<=now()
    AND NOT EXISTS(SELECT 1 FROM vip_reward_ledger x WHERE x.tenant_id=e.tenant_id AND x.store_id=e.store_id AND x.related_entry_id=e.id AND x.entry_type IN ('EXPIRE','REFUND_CLAWBACK','REVERSAL')) FOR UPDATE OF e`,values);
  let expired=0;
  for(const entry of due.rows){
    const remaining=money(Math.max(0,Number(entry.amount)-Number(entry.allocated_amount||0)));if(remaining<=0)continue;
    const result=await client.query(`INSERT INTO vip_reward_ledger(id,public_id,tenant_id,store_id,customer_id,order_id,benefit_id,order_vip_benefit_id,related_entry_id,entry_type,amount,currency,source_key,description,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'EXPIRE',$10,$11,$12,$13,$14::jsonb) ON CONFLICT (tenant_id,store_id,source_key) DO NOTHING RETURNING id`,[uuid(),publicId('vrl'),tenantId,storeId,entry.customer_id,entry.order_id,entry.benefit_id,entry.order_vip_benefit_id,entry.id,-remaining,entry.currency,`EXPIRE:${entry.public_id}`,'VIP reward expired',JSON.stringify({source_entry_id:entry.public_id,allocated_amount:money(entry.allocated_amount||0),expired_amount:remaining})]);
    expired+=result.rowCount;
  }
  return expired;
}

export async function expireDueVipEntitlements(client,{tenantId,storeId,customerId=null}){
  const values=[tenantId,storeId];let customer='';if(customerId){values.push(customerId);customer=` AND customer_id=$${values.length}`;}
  const result=await client.query(`UPDATE vip_entitlements SET status='EXPIRED',updated_at=now() WHERE tenant_id=$1 AND store_id=$2${customer} AND status='AVAILABLE' AND expires_at IS NOT NULL AND expires_at<=now()`,values);
  return result.rowCount;
}

export async function createVipEntitlement(client,{tenantId,storeId,customerId,levelId,benefitId,orderId,type,config,issuanceKey}){
  const expires=type==='VOUCHER'?nowPlusDays(config.validity_days):null;const redeemCode=type==='VOUCHER'?publicId('VIPV').toUpperCase():null;
  const result=await client.query(`INSERT INTO vip_entitlements(id,public_id,tenant_id,store_id,customer_id,level_id,benefit_id,source_order_id,entitlement_type,status,redeem_code,issuance_key,payload_snapshot,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'AVAILABLE',$10,$11,$12::jsonb,$13) ON CONFLICT (tenant_id,store_id,issuance_key) DO NOTHING RETURNING public_id`,[uuid(),publicId('vent'),tenantId,storeId,customerId,levelId,benefitId,orderId,type,redeemCode,issuanceKey,JSON.stringify(config||{}),expires]);
  return result.rowCount?result.rows[0].public_id:null;
}

export async function processVipOrderCompletion(client,{tenantId,storeId,order}){
  const snapshots=await client.query(`SELECT ovb.*,b.public_id AS benefit_public_id,b.name AS benefit_name FROM order_vip_benefits ovb JOIN vip_benefits b ON b.id=ovb.benefit_id AND b.tenant_id=ovb.tenant_id AND b.store_id=ovb.store_id WHERE ovb.tenant_id=$1 AND ovb.store_id=$2 AND ovb.order_id=$3 FOR UPDATE OF ovb`,[tenantId,storeId,order.id]);
  const cashback=[];let earned=0,issued=0;
  for(const row of snapshots.rows){
    if(row.status!=='SNAPSHOT')continue;
    if(row.benefit_type==='CASHBACK'){cashback.push({...row,calculated:calculateVipCashback(row.config_snapshot,order)});continue;}
    if(row.benefit_type==='VOUCHER'||row.benefit_type==='GIFT'){
      const type=row.benefit_type;const entitlement=await createVipEntitlement(client,{tenantId,storeId,customerId:order.customer_id,levelId:row.level_id,benefitId:row.benefit_id,orderId:order.id,type,config:json(row.config_snapshot),issuanceKey:`ORDER:${order.public_id}:BENEFIT:${row.benefit_public_id}`});
      await client.query(`UPDATE order_vip_benefits SET status='ISSUED',executed_at=COALESCE(executed_at,now()),reason=COALESCE(reason,$1) WHERE id=$2`,[entitlement?`${type} entitlement issued`:`${type} entitlement already issued`,row.id]);
      if(entitlement)issued++;
    }
  }
  cashback.sort((a,b)=>b.calculated-a.calculated||String(a.created_at).localeCompare(String(b.created_at)));
  const winner=cashback.find(item=>item.calculated>0)||null;
  for(const row of cashback){
    if(row!==winner){await client.query(`UPDATE order_vip_benefits SET status='SKIPPED',executed_at=now(),reason=$1 WHERE id=$2`,[row.calculated>0?'A higher-value cashback benefit was selected':'Cashback calculation produced no reward',row.id]);continue;}
    const config=json(row.config_snapshot),expires=nowPlusDays(config.expires_days);
    const inserted=await client.query(`INSERT INTO vip_reward_ledger(id,public_id,tenant_id,store_id,customer_id,order_id,benefit_id,order_vip_benefit_id,entry_type,amount,currency,source_key,description,metadata,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'EARN',$9,$10,$11,$12,$13::jsonb,$14) ON CONFLICT (tenant_id,store_id,source_key) DO NOTHING RETURNING public_id`,[uuid(),publicId('vrl'),tenantId,storeId,order.customer_id,order.id,row.benefit_id,row.id,row.calculated,order.currency,`ORDER:${order.public_id}:CASHBACK:${row.benefit_public_id}`,`${row.benefit_name} cashback`,JSON.stringify({order_id:order.public_id,benefit_id:row.benefit_public_id}),expires]);
    await client.query(`UPDATE order_vip_benefits SET status='EARNED',amount=$1,executed_at=COALESCE(executed_at,now()),reason='Cashback earned after completed order' WHERE id=$2`,[row.calculated,row.id]);
    if(inserted.rowCount)earned+=row.calculated;
  }
  const policy=await client.query(`SELECT enabled,upgrade_policy FROM vip_programs WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);let evaluation=null;
  if(policy.rows[0]?.enabled&&policy.rows[0]?.upgrade_policy==='IMMEDIATE')evaluation=await evaluateCustomerVip(client,{tenantId,storeId,customerId:order.customer_id,actorType:'SYSTEM',source:'ORDER',reason:`Order ${order.order_number} completed`});
  return {cashback_earned:money(earned),entitlements_issued:issued,tier_changed:!!evaluation?.changed};
}

export async function processVipOrderRefund(client,{tenantId,storeId,order,refundRef}){
  await expireDueVipRewards(client,{tenantId,storeId,customerId:order.customer_id});
  const earns=await client.query(`SELECT e.*,
      COALESCE((SELECT abs(sum(x.amount)) FROM vip_reward_ledger x WHERE x.tenant_id=e.tenant_id AND x.store_id=e.store_id AND x.related_entry_id=e.id AND x.entry_type IN ('EXPIRE','REFUND_CLAWBACK','REVERSAL')),0)::numeric AS reversed_amount
    FROM vip_reward_ledger e WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.order_id=$3 AND e.entry_type='EARN' FOR UPDATE OF e`,[tenantId,storeId,order.id]);let clawed=0;
  for(const entry of earns.rows){
    const amount=money(Math.max(0,Number(entry.amount)-Number(entry.reversed_amount||0)));if(amount<=0)continue;
    const sourceKey=`REFUND:${refundRef}:EARN:${entry.public_id}`;
    const inserted=await client.query(`INSERT INTO vip_reward_ledger(id,public_id,tenant_id,store_id,customer_id,order_id,benefit_id,order_vip_benefit_id,related_entry_id,entry_type,amount,currency,source_key,description,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'REFUND_CLAWBACK',$10,$11,$12,'Cashback clawed back after refund',$13::jsonb) ON CONFLICT (tenant_id,store_id,source_key) DO NOTHING RETURNING id`,[uuid(),publicId('vrl'),tenantId,storeId,order.customer_id,order.id,entry.benefit_id,entry.order_vip_benefit_id,entry.id,-amount,entry.currency,sourceKey,JSON.stringify({refund_id:refundRef,earned_entry_id:entry.public_id})]);
    if(inserted.rowCount)clawed=money(clawed+amount);
  }
  const restored=await restoreVipCashbackRedemptionForOrder(client,{tenantId,storeId,orderId:order.id,restorationKey:`REFUND:${refundRef}`,reason:`VIP cashback restored after refund ${refundRef}`});
  await client.query(`UPDATE order_vip_benefits SET status='REVERSED',reversed_at=COALESCE(reversed_at,now()),reason='Order refunded' WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN ('APPLIED','EARNED','ISSUED')`,[tenantId,storeId,order.id]);
  const cancelled=await client.query(`UPDATE vip_entitlements SET status='CANCELLED',cancelled_at=now(),updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND source_order_id=$3 AND status='AVAILABLE'`,[tenantId,storeId,order.id]);
  const program=await client.query(`SELECT 1 FROM vip_programs WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);let evaluation=null;
  if(program.rowCount)evaluation=await evaluateCustomerVip(client,{tenantId,storeId,customerId:order.customer_id,actorType:'SYSTEM',source:'REFUND',reason:`Refund ${refundRef} completed`});
  return {cashback_clawed_back:money(clawed),cashback_redemption_restored:money(restored.amount),entitlements_cancelled:cancelled.rowCount,tier_changed:!!evaluation?.changed};
}

export async function vipRewardAccount(client,{tenantId,storeId,customerId,ledgerLimit=100}){
  await expireDueVipRewards(client,{tenantId,storeId,customerId});await expireDueVipEntitlements(client,{tenantId,storeId,customerId});
  const [balance,ledger,entitlements,currency]=await Promise.all([
    client.query(`SELECT COALESCE(sum(amount),0)::numeric AS balance FROM vip_reward_ledger WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3`,[tenantId,storeId,customerId]),
    client.query(`SELECT l.public_id AS id,l.entry_type,l.amount,l.currency,l.description,l.metadata,l.expires_at,l.created_at,o.public_id AS order_id,o.order_number,b.public_id AS benefit_id,b.name AS benefit_name FROM vip_reward_ledger l LEFT JOIN orders o ON o.id=l.order_id AND o.tenant_id=l.tenant_id AND o.store_id=l.store_id LEFT JOIN vip_benefits b ON b.id=l.benefit_id AND b.tenant_id=l.tenant_id AND b.store_id=l.store_id WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.customer_id=$3 ORDER BY l.created_at DESC,l.id DESC LIMIT $4`,[tenantId,storeId,customerId,ledgerLimit]),
    client.query(`SELECT e.public_id AS id,e.entitlement_type,e.status,e.redeem_code,e.payload_snapshot,e.valid_from,e.expires_at,e.issued_at,e.redeemed_at,e.cancelled_at,b.public_id AS benefit_id,b.name AS benefit_name,o.public_id AS source_order_id,o.order_number AS source_order_number FROM vip_entitlements e JOIN vip_benefits b ON b.id=e.benefit_id AND b.tenant_id=e.tenant_id AND b.store_id=e.store_id LEFT JOIN orders o ON o.id=e.source_order_id AND o.tenant_id=e.tenant_id AND o.store_id=e.store_id WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.customer_id=$3 ORDER BY e.created_at DESC,e.id DESC LIMIT 100`,[tenantId,storeId,customerId]),
    client.query(`SELECT currency FROM tenant_settings WHERE tenant_id=$1`,[tenantId]),
  ]);
  return {balance:money(balance.rows[0]?.balance),currency:currency.rows[0]?.currency||'USD',ledger:ledger.rows,entitlements:entitlements.rows};
}

export async function adjustVipReward(client,{tenantId,storeId,customerId,amount,reason,expiresAt=null,actorId=null}){
  const value=money(amount);if(!Number.isFinite(value)||value===0)throw errors.badRequest('VIP_REWARD_ADJUSTMENT_INVALID','Reward adjustment must be a non-zero amount');
  const account=await vipRewardAccount(client,{tenantId,storeId,customerId,ledgerLimit:1});if(value<0&&money(account.balance+value)<0)throw errors.conflict('VIP_REWARD_BALANCE_INSUFFICIENT','Adjustment would make the reward balance negative');
  const sourceKey=`ADMIN:${publicId('vadj')}`;
  await client.query(`INSERT INTO vip_reward_ledger(id,public_id,tenant_id,store_id,customer_id,entry_type,amount,currency,source_key,description,metadata,expires_at)
    VALUES($1,$2,$3,$4,$5,'ADMIN_ADJUSTMENT',$6,$7,$8,$9,$10::jsonb,$11)`,[uuid(),publicId('vrl'),tenantId,storeId,customerId,value,account.currency,sourceKey,reason,JSON.stringify({actor_id:actorId||null}),value>0?expiresAt:null]);
  return vipRewardAccount(client,{tenantId,storeId,customerId});
}

export async function vipExecutionSummary(client,{tenantId,storeId}){
  await expireDueVipRewards(client,{tenantId,storeId});await expireDueVipEntitlements(client,{tenantId,storeId});
  const [program,members,rewards,entitlements]=await Promise.all([
    client.query(`SELECT enabled,upgrade_policy FROM vip_programs WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]),
    client.query(`SELECT count(*)::int AS evaluated,count(*) FILTER(WHERE level_id IS NOT NULL)::int AS vip_members,count(*) FILTER(WHERE level_id IS NULL)::int AS without_level FROM customer_vip_status WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]),
    client.query(`SELECT COALESCE(sum(amount),0)::numeric AS balance_total,COALESCE(sum(amount) FILTER(WHERE entry_type='EARN' AND created_at>=now()-interval '30 days'),0)::numeric AS earned_30d,COALESCE(abs(sum(amount) FILTER(WHERE entry_type='REFUND_CLAWBACK' AND created_at>=now()-interval '30 days')),0)::numeric AS clawed_back_30d FROM vip_reward_ledger WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]),
    client.query(`SELECT count(*) FILTER(WHERE status='AVAILABLE')::int AS available,count(*) FILTER(WHERE status='REDEEMED')::int AS redeemed FROM vip_entitlements WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]),
  ]);
  return {program:program.rows[0]||{enabled:false,upgrade_policy:'IMMEDIATE'},evaluated_customers:Number(members.rows[0]?.evaluated||0),vip_members:Number(members.rows[0]?.vip_members||0),without_level:Number(members.rows[0]?.without_level||0),reward_balance_total:money(rewards.rows[0]?.balance_total),cashback_earned_30d:money(rewards.rows[0]?.earned_30d),cashback_clawed_back_30d:money(rewards.rows[0]?.clawed_back_30d),available_entitlements:Number(entitlements.rows[0]?.available||0),redeemed_entitlements:Number(entitlements.rows[0]?.redeemed||0)};
}