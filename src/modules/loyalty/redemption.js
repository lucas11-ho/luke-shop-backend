import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';

const money=value=>Number(Number(value||0).toFixed(4));

async function lockCustomer(client,{tenantId,customerId}){
  const row=await client.query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,customerId]);
  if(!row.rowCount)throw errors.notFound('CUSTOMER_NOT_FOUND','Customer not found');
}

export async function vipCashbackRedemptionPolicy(client,{tenantId,storeId}){
  const result=await client.query(`SELECT enabled,cashback_redemption_enabled,cashback_redemption_max_percent,cashback_redemption_min_amount
    FROM vip_programs WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);
  const row=result.rows[0];
  return {enabled:Boolean(row?.enabled&&row?.cashback_redemption_enabled),max_percent:Number(row?.cashback_redemption_max_percent??100),min_amount:money(row?.cashback_redemption_min_amount||0)};
}

export async function vipCashbackAvailableBalance(client,{tenantId,storeId,customerId,currency}){
  const row=await client.query(`SELECT COALESCE(sum(amount),0)::numeric AS balance FROM vip_reward_ledger
    WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND currency=$4`,[tenantId,storeId,customerId,currency]);
  return money(Math.max(0,Number(row.rows[0]?.balance||0)));
}

async function spendableSources(client,{tenantId,storeId,customerId,currency}){
  const result=await client.query(`SELECT e.*,
      COALESCE((SELECT sum(a.amount) FROM vip_reward_redemption_allocations a
        WHERE a.tenant_id=e.tenant_id AND a.store_id=e.store_id AND a.source_ledger_entry_id=e.id),0)::numeric AS allocated_amount
    FROM vip_reward_ledger e
    WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.customer_id=$3 AND e.currency=$4
      AND ((e.entry_type IN ('EARN','REDEMPTION_RESTORE')) OR (e.entry_type='ADMIN_ADJUSTMENT' AND e.amount>0))
      AND (e.expires_at IS NULL OR e.expires_at>now())
      AND NOT EXISTS(SELECT 1 FROM vip_reward_ledger x
        WHERE x.tenant_id=e.tenant_id AND x.store_id=e.store_id AND x.related_entry_id=e.id
          AND x.entry_type IN ('EXPIRE','REFUND_CLAWBACK','REVERSAL'))
    ORDER BY e.expires_at ASC NULLS LAST,e.created_at,e.id
    FOR UPDATE OF e`,[tenantId,storeId,customerId,currency]);
  return result.rows.map(row=>({...row,remaining:money(Math.max(0,Number(row.amount)-Number(row.allocated_amount||0)))})).filter(row=>row.remaining>0);
}

export async function applyVipCashbackRedemption(client,{tenantId,storeId,customerId,orderId,orderPublicId,currency,requestedAmount,maxAmount}){
  const requested=money(requestedAmount);const payable=money(maxAmount);
  if(requested<=0)return null;
  const policy=await vipCashbackRedemptionPolicy(client,{tenantId,storeId});
  if(!policy.enabled)throw errors.conflict('VIP_REDEMPTION_DISABLED','VIP cashback redemption is not enabled for this store');
  if(requested<policy.min_amount)throw errors.badRequest('VIP_REDEMPTION_MINIMUM_NOT_MET',`VIP cashback redemption must be at least ${policy.min_amount.toFixed(2)}`);
  const policyCap=money(payable*Math.max(0,Math.min(100,policy.max_percent))/100);const serverMax=money(Math.min(payable,policyCap));
  if(requested>serverMax)throw errors.badRequest('VIP_REDEMPTION_EXCEEDS_LIMIT','VIP cashback redemption exceeds the server-authorized checkout limit');
  await lockCustomer(client,{tenantId,customerId});
  const balance=await vipCashbackAvailableBalance(client,{tenantId,storeId,customerId,currency});
  if(requested>balance)throw errors.conflict('VIP_REWARD_BALANCE_INSUFFICIENT','VIP cashback balance changed; refresh rewards and try again');
  const sources=await spendableSources(client,{tenantId,storeId,customerId,currency});
  let remaining=requested;const allocations=[];
  for(const source of sources){if(remaining<=0)break;const amount=money(Math.min(remaining,source.remaining));if(amount<=0)continue;allocations.push({source,amount});remaining=money(remaining-amount);}
  if(remaining>0)throw errors.conflict('VIP_REWARD_SOURCES_INSUFFICIENT','VIP reward sources changed; refresh rewards and try again');
  const ledgerId=uuid(),ledgerPublicId=publicId('vrl'),redemptionId=uuid(),redemptionPublicId=publicId('vrd');
  await client.query(`INSERT INTO vip_reward_ledger(id,public_id,tenant_id,store_id,customer_id,order_id,entry_type,amount,currency,source_key,description,metadata)
    VALUES($1,$2,$3,$4,$5,$6,'REDEEM',$7,$8,$9,'VIP cashback redeemed at checkout',$10::jsonb)`,[ledgerId,ledgerPublicId,tenantId,storeId,customerId,orderId,-requested,currency,`ORDER:${orderPublicId}:CASHBACK_REDEEM`,JSON.stringify({order_id:orderPublicId,redemption_id:redemptionPublicId,max_authorized:serverMax})]);
  await client.query(`INSERT INTO vip_reward_redemptions(id,public_id,tenant_id,store_id,customer_id,order_id,ledger_entry_id,amount,currency)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[redemptionId,redemptionPublicId,tenantId,storeId,customerId,orderId,ledgerId,requested,currency]);
  for(const allocation of allocations)await client.query(`INSERT INTO vip_reward_redemption_allocations(id,tenant_id,store_id,redemption_id,source_ledger_entry_id,amount)
    VALUES($1,$2,$3,$4,$5,$6)`,[uuid(),tenantId,storeId,redemptionId,allocation.source.id,allocation.amount]);
  return {id:redemptionPublicId,internal_id:redemptionId,ledger_entry_id:ledgerId,amount:requested,currency,balance_before:balance,balance_after:money(balance-requested),max_authorized:serverMax,allocations:allocations.map(item=>({source_entry_id:item.source.public_id,amount:item.amount,expires_at:item.source.expires_at||null}))};
}

export async function restoreVipCashbackRedemptionForOrder(client,{tenantId,storeId,orderId,restorationKey,reason}){
  const redemption=(await client.query(`SELECT * FROM vip_reward_redemptions WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE`,[tenantId,storeId,orderId])).rows[0];
  if(!redemption||redemption.status==='RESTORED')return {restored:false,amount:0};
  const allocations=await client.query(`SELECT a.*,e.public_id AS source_public_id,e.customer_id,e.benefit_id,e.order_vip_benefit_id,e.currency,e.expires_at
    FROM vip_reward_redemption_allocations a JOIN vip_reward_ledger e ON e.tenant_id=a.tenant_id AND e.store_id=a.store_id AND e.id=a.source_ledger_entry_id
    WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.redemption_id=$3 ORDER BY a.created_at,a.id FOR UPDATE OF a`,[tenantId,storeId,redemption.id]);
  let restored=0;
  for(const row of allocations.rows){const sourceKey=`REDEEM_RESTORE:${restorationKey}:ALLOC:${row.id}`;const inserted=await client.query(`INSERT INTO vip_reward_ledger(id,public_id,tenant_id,store_id,customer_id,order_id,benefit_id,order_vip_benefit_id,related_entry_id,entry_type,amount,currency,source_key,description,metadata,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'REDEMPTION_RESTORE',$10,$11,$12,$13,$14::jsonb,$15)
      ON CONFLICT (tenant_id,store_id,source_key) DO NOTHING RETURNING id`,[uuid(),publicId('vrl'),tenantId,storeId,row.customer_id,orderId,row.benefit_id,row.order_vip_benefit_id,redemption.ledger_entry_id,row.amount,row.currency,sourceKey,reason||'VIP cashback redemption restored',JSON.stringify({redemption_id:redemption.public_id,source_entry_id:row.source_public_id}),row.expires_at]);if(inserted.rowCount)restored=money(restored+Number(row.amount));}
  await client.query(`UPDATE vip_reward_redemptions SET status='RESTORED',restoration_reason=$1,restored_at=COALESCE(restored_at,now()),updated_at=now() WHERE id=$2`,[reason||'Redemption restored',redemption.id]);
  return {restored:true,amount:restored,redemption_id:redemption.public_id};
}

export async function vipRedemptionForOrder(client,{tenantId,storeId,orderId}){
  const result=await client.query(`SELECT public_id AS id,amount,currency,status,created_at,restored_at FROM vip_reward_redemptions WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`,[tenantId,storeId,orderId]);
  return result.rows[0]||null;
}
