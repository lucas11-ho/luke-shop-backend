import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{getVipAnalytics}from'../src/modules/loyalty/analytics.js';

const db=createDatabase(loadConfig());
const suffix=randomUUID().replaceAll('-','').slice(0,10);
const ids={tenant:randomUUID(),store:randomUUID(),program:randomUUID(),silver:randomUUID(),gold:randomUUID(),benefit:randomUUID(),a:randomUUID(),b:randomUUID()};
const refs={tenant:`tnt_va_${suffix}`,store:`str_va_${suffix}`,program:`vipg_va_${suffix}`,silver:`vipl_s_${suffix}`,gold:`vipl_g_${suffix}`,benefit:`vipb_va_${suffix}`,a:`cus_va_a_${suffix}`,b:`cus_va_b_${suffix}`};
const now=new Date('2026-09-04T12:00:00.000Z');

async function ledger(customerId,label,type,amount,at){
 await db.query(`INSERT INTO vip_reward_ledger(id,public_id,tenant_id,store_id,customer_id,entry_type,amount,currency,source_key,description,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9,$10)`,[randomUUID(),`viplgr_${label}_${suffix}`,ids.tenant,ids.store,customerId,type,amount,`analytics:${label}:${suffix}`,`Analytics ${label}`,at]);
}
async function entitlement(label,customerId,status,issuedAt,{redeemedAt=null,updatedAt=issuedAt}={}){
 await db.query(`INSERT INTO vip_entitlements(id,public_id,tenant_id,store_id,customer_id,level_id,benefit_id,entitlement_type,status,issuance_key,issued_at,redeemed_at,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,'VOUCHER',$8,$9,$10,$11,$10,$12)`,[randomUUID(),`vipe_${label}_${suffix}`,ids.tenant,ids.store,customerId,customerId===ids.a?ids.gold:ids.silver,ids.benefit,status,`analytics:${label}:${suffix}`,issuedAt,redeemedAt,updatedAt]);
}

try{
 await db.query(`INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')`,[ids.tenant,refs.tenant,`vip-analytics-${suffix}`,`VIP Analytics ${suffix}`]);
 await db.query(`INSERT INTO tenant_settings(tenant_id,currency,timezone) VALUES($1,'USD','Asia/Phnom_Penh') ON CONFLICT(tenant_id) DO UPDATE SET currency='USD',timezone='Asia/Phnom_Penh'`,[ids.tenant]);
 await db.query(`INSERT INTO stores(id,public_id,tenant_id,slug,name,status,is_primary) VALUES($1,$2,$3,$4,$5,'ACTIVE',true)`,[ids.store,refs.store,ids.tenant,`vip-analytics-store-${suffix}`,`VIP Analytics Store ${suffix}`]);
 await db.query(`INSERT INTO vip_programs(id,public_id,tenant_id,store_id,enabled) VALUES($1,$2,$3,$4,true)`,[ids.program,refs.program,ids.tenant,ids.store]);
 await db.query(`INSERT INTO vip_levels(id,public_id,tenant_id,store_id,program_id,code,name,status,sort_order,qualification_mode,spend_threshold) VALUES
  ($1,$2,$3,$4,$5,'SILVER','Silver','ACTIVE',10,'SPEND',0),($6,$7,$3,$4,$5,'GOLD','Gold','ACTIVE',20,'SPEND',100)`,[ids.silver,refs.silver,ids.tenant,ids.store,ids.program,ids.gold,refs.gold]);
 await db.query(`INSERT INTO vip_benefits(id,public_id,tenant_id,store_id,level_id,name,benefit_type,frequency,status,config) VALUES($1,$2,$3,$4,$5,'Analytics voucher','VOUCHER','MANUAL','ACTIVE',$6::jsonb)`,[ids.benefit,refs.benefit,ids.tenant,ids.store,ids.gold,JSON.stringify({discount_type:'FIXED',value:5,validity_days:30})]);
 await db.query(`INSERT INTO customers(id,public_id,tenant_id,display_name,status) VALUES($1,$2,$3,'Analytics Alpha','ACTIVE'),($4,$5,$3,'Analytics Beta','ACTIVE')`,[ids.a,refs.a,ids.tenant,ids.b,refs.b]);
 await db.query(`INSERT INTO customer_vip_status(id,public_id,tenant_id,store_id,customer_id,level_id,assignment_source,locked,qualified_spend,qualified_orders) VALUES
  ($1,$2,$3,$4,$5,$6,'AUTO',false,250,5),($7,$8,$3,$4,$9,$10,'AUTO',false,80,2)`,[randomUUID(),`vipm_a_${suffix}`,ids.tenant,ids.store,ids.a,ids.gold,randomUUID(),`vipm_b_${suffix}`,ids.b,ids.silver]);
 await db.query(`INSERT INTO vip_tier_history(tenant_id,store_id,customer_id,from_level_id,to_level_id,source,reason,actor_type,created_at) VALUES
  ($1,$2,$3,NULL,$4,'EVALUATION','Entered Silver','SYSTEM','2026-08-20T12:00:00Z'),
  ($1,$2,$3,$4,$5,'EVALUATION','Upgraded to Gold','SYSTEM','2026-09-02T12:00:00Z'),
  ($1,$2,$6,$5,$4,'EVALUATION','Downgraded to Silver','SYSTEM','2026-09-03T12:00:00Z')`,[ids.tenant,ids.store,ids.a,ids.silver,ids.gold,ids.b]);

 await ledger(ids.a,'a-earn','EARN',100,'2026-09-01T10:00:00Z');
 await ledger(ids.a,'a-redeem','REDEEM',-25,'2026-09-02T10:00:00Z');
 await ledger(ids.b,'b-earn','EARN',40,'2026-09-01T11:00:00Z');
 await ledger(ids.b,'b-redeem','REDEEM',-60,'2026-09-03T11:00:00Z');
 await entitlement('available',ids.a,'AVAILABLE','2026-09-01T09:00:00Z');
 await entitlement('redeemed',ids.a,'REDEEMED','2026-09-01T09:30:00Z',{redeemedAt:'2026-09-03T09:30:00Z',updatedAt:'2026-09-03T09:30:00Z'});
 await entitlement('expired',ids.b,'EXPIRED','2026-08-25T09:00:00Z',{updatedAt:'2026-09-02T09:00:00Z'});

 const data=await getVipAnalytics(db,{tenantId:ids.tenant,storeId:ids.store,days:30,now});
 assert.equal(data.currency,'USD');
 assert.equal(data.summary.vip_members,2);
 assert.equal(data.summary.reward_liability,75,'negative balance from one customer must not offset another customer positive liability');
 assert.equal(data.summary.reward_credits,140);
 assert.equal(data.summary.reward_debits,85);
 assert.equal(data.summary.cashback_redeemed,0);
 assert.equal(data.summary.cashback_restored,0);
 assert.equal(data.summary.entitlements_issued,3);
 assert.equal(data.summary.entitlements_available,1);
 assert.equal(data.summary.entitlements_redeemed,1);
 assert.equal(data.summary.entitlements_expired,1);
 assert.equal(data.summary.tier_entries,1);
 assert.equal(data.summary.tier_upgrades,1);
 assert.equal(data.summary.tier_downgrades,1);
 assert.deepEqual(Object.fromEntries(data.by_level.map(row=>[row.code,row.members])),{SILVER:1,GOLD:1});
 assert.equal(data.top_reward_balances.length,1,'non-positive customer balances must be excluded from liability leaderboard');
 assert.equal(data.top_reward_balances[0].customer_id,refs.a);
 assert.equal(data.top_reward_balances[0].balance,75);
 assert.ok(data.reward_by_type.some(row=>row.entry_type==='EARN'&&row.entries===2&&row.net_amount===140));
 assert.ok(data.entitlements_by_status.some(row=>row.status==='AVAILABLE'&&row.entitlements===1));
 assert.ok(data.trend.length>=3,'daily trend must be derived from persisted loyalty events');
 assert.ok(data.recent_activity.some(row=>row.kind==='REWARD'));
 assert.ok(data.recent_activity.some(row=>row.kind==='ENTITLEMENT'));
 assert.ok(data.recent_activity.some(row=>row.kind==='TIER'));
 console.log('PASS VIP analytics executes against PostgreSQL and preserves tenant/store scoping, per-customer reward liability, entitlement health and tier movement');
}finally{
 await db.query('DELETE FROM tenants WHERE id=$1',[ids.tenant]).catch(()=>{});
 await db.close().catch(()=>{});
}
