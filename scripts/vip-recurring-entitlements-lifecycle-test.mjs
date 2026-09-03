import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{issueManualVipEntitlement,recurringVipIssuancePolicy,runRecurringVipEntitlements}from'../src/modules/loyalty/issuance.js';

const db=createDatabase(loadConfig());
const suffix=randomUUID().replaceAll('-','').slice(0,10);
const ids={tenant:randomUUID(),store:randomUUID(),program:randomUUID(),level:randomUUID()};
const refs={tenant:`tnt_vri_${suffix}`,store:`str_vri_${suffix}`,program:`vipg_vri_${suffix}`,level:`vipl_vri_${suffix}`};
const benefitIds={monthly:randomUUID(),annual:randomUUID(),birthday:randomUUID(),tier:randomUUID(),manual:randomUUID()};
const benefitRefs={monthly:`vipb_monthly_${suffix}`,annual:`vipb_annual_${suffix}`,birthday:`vipb_birthday_${suffix}`,tier:`vipb_tier_${suffix}`,manual:`vipb_manual_${suffix}`};
const now=new Date('2026-09-03T12:00:00.000Z');

async function customer(label,birthDate,historyAt){
  const id=randomUUID(),publicId=`cus_vri_${label}_${suffix}`;
  await db.query(`INSERT INTO customers(id,public_id,tenant_id,display_name,status,birth_date) VALUES($1,$2,$3,$4,'ACTIVE',$5)`,[id,publicId,ids.tenant,`Recurring ${label}`,birthDate]);
  await db.query(`INSERT INTO customer_vip_status(id,public_id,tenant_id,store_id,customer_id,level_id,assignment_source,locked) VALUES($1,$2,$3,$4,$5,$6,'AUTO',false)`,[randomUUID(),`vipm_${label}_${suffix}`,ids.tenant,ids.store,id,ids.level]);
  await db.query(`INSERT INTO vip_tier_history(tenant_id,store_id,customer_id,from_level_id,to_level_id,source,reason,actor_type,created_at) VALUES($1,$2,$3,$4,$5,'EVALUATION','Lifecycle tier entry','SYSTEM',$6)`,[ids.tenant,ids.store,id,null,ids.level,historyAt]);
  return{id,publicId};
}

try{
  await db.query(`INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')`,[ids.tenant,refs.tenant,`vip-recurring-${suffix}`,`VIP Recurring ${suffix}`]);
  await db.query(`INSERT INTO tenant_settings(tenant_id,currency,timezone) VALUES($1,'USD','Asia/Phnom_Penh') ON CONFLICT(tenant_id) DO UPDATE SET currency='USD',timezone='Asia/Phnom_Penh'`,[ids.tenant]);
  await db.query(`INSERT INTO stores(id,public_id,tenant_id,slug,name,status,is_primary) VALUES($1,$2,$3,$4,$5,'ACTIVE',true)`,[ids.store,refs.store,ids.tenant,`vip-recurring-store-${suffix}`,`VIP Recurring Store ${suffix}`]);
  await db.query(`INSERT INTO vip_programs(id,public_id,tenant_id,store_id,enabled,recurring_entitlement_issuance_enabled) VALUES($1,$2,$3,$4,true,false)`,[ids.program,refs.program,ids.tenant,ids.store]);
  await db.query(`INSERT INTO vip_levels(id,public_id,tenant_id,store_id,program_id,code,name,status,sort_order,qualification_mode,spend_threshold) VALUES($1,$2,$3,$4,$5,'GOLD','Gold','ACTIVE',10,'SPEND',0)`,[ids.level,refs.level,ids.tenant,ids.store,ids.program]);
  const benefits=[
    [benefitIds.monthly,benefitRefs.monthly,'Monthly voucher','VOUCHER','MONTHLY',{discount_type:'FIXED',value:5,min_order:0,max_discount:null,validity_days:30}],
    [benefitIds.annual,benefitRefs.annual,'Annual gift','GIFT','ANNUAL',{product_id:null,present_name:'Annual VIP gift',notes:null}],
    [benefitIds.birthday,benefitRefs.birthday,'Birthday voucher','VOUCHER','BIRTHDAY',{discount_type:'FIXED',value:10,min_order:0,max_discount:null,validity_days:14}],
    [benefitIds.tier,benefitRefs.tier,'Tier entry gift','GIFT','TIER_ENTRY',{product_id:null,present_name:'Welcome gift',notes:null}],
    [benefitIds.manual,benefitRefs.manual,'Manual care voucher','VOUCHER','MANUAL',{discount_type:'FIXED',value:7,min_order:0,max_discount:null,validity_days:7}],
  ];
  for(const[bId,bRef,name,type,frequency,config]of benefits)await db.query(`INSERT INTO vip_benefits(id,public_id,tenant_id,store_id,level_id,name,benefit_type,frequency,status,config) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9::jsonb)`,[bId,bRef,ids.tenant,ids.store,ids.level,name,type,frequency,JSON.stringify(config)]);

  const before=await recurringVipIssuancePolicy(db,{tenantId:ids.tenant,storeId:ids.store});
  assert.equal(before.program_enabled,true);assert.equal(before.recurring_entitlement_issuance_enabled,false);assert.equal(before.enabled,false,'scheduled issuance must default off');
  const disabledRun=await db.transaction(client=>runRecurringVipEntitlements(client,{tenantId:ids.tenant,storeId:ids.store,now}));
  assert.equal(disabledRun.issued,0);

  const oldEntry=await customer('old','1990-09-03','2026-08-31T12:00:00.000Z');
  const newEntry=await customer('new','1991-01-20','2026-09-02T12:00:00.000Z');
  await db.query(`UPDATE vip_programs SET recurring_entitlement_issuance_enabled=true,recurring_entitlement_issuance_enabled_at='2026-09-01T00:00:00.000Z' WHERE id=$1`,[ids.program]);

  const firstPage=await db.transaction(client=>runRecurringVipEntitlements(client,{tenantId:ids.tenant,storeId:ids.store,now,limit:1}));
  assert.equal(firstPage.processed_members,1);assert.ok(firstPage.last_customer_id,'first page must return a scheduler cursor');assert.equal(firstPage.has_more,true,'a full first page must allow the scheduler to continue');
  const secondPage=await db.transaction(client=>runRecurringVipEntitlements(client,{tenantId:ids.tenant,storeId:ids.store,now,limit:1,afterCustomerId:firstPage.last_customer_id}));
  assert.equal(secondPage.processed_members,1);assert.ok(secondPage.last_customer_id);assert.notEqual(secondPage.last_customer_id,firstPage.last_customer_id,'keyset cursor must advance to the next member');
  const exhaustedPage=await db.transaction(client=>runRecurringVipEntitlements(client,{tenantId:ids.tenant,storeId:ids.store,now,limit:1,afterCustomerId:secondPage.last_customer_id}));
  assert.equal(exhaustedPage.processed_members,0);assert.equal(exhaustedPage.has_more,false);assert.equal(exhaustedPage.last_customer_id,null);
  const issuedAcrossPages=firstPage.issued+secondPage.issued;
  const frequencies=Object.fromEntries(Object.keys(firstPage.by_frequency).map(key=>[key,Number(firstPage.by_frequency[key]||0)+Number(secondPage.by_frequency[key]||0)]));
  assert.equal(issuedAcrossPages,6,'two paginated members must receive two monthly + two annual + one birthday + one post-enable tier-entry entitlement');
  assert.deepEqual(frequencies,{TIER_ENTRY:1,MONTHLY:2,ANNUAL:2,BIRTHDAY:1});
  const oldTier=await db.query(`SELECT count(*)::int AS count FROM vip_entitlements WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND benefit_id=$4`,[ids.tenant,ids.store,oldEntry.id,benefitIds.tier]);
  assert.equal(oldTier.rows[0].count,0,'tier-entry history before enablement must never backfill');
  const newTier=await db.query(`SELECT count(*)::int AS count FROM vip_entitlements WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND benefit_id=$4`,[ids.tenant,ids.store,newEntry.id,benefitIds.tier]);
  assert.equal(newTier.rows[0].count,1);

  const second=await db.transaction(client=>runRecurringVipEntitlements(client,{tenantId:ids.tenant,storeId:ids.store,now}));
  assert.equal(second.issued,0,'same-period rerun must be idempotent');
  assert.equal(second.already_issued,6);

  const manualOne=await db.transaction(client=>issueManualVipEntitlement(client,{tenantId:ids.tenant,storeId:ids.store,customerId:oldEntry.id,benefitRef:benefitRefs.manual,requestKey:`manual-${suffix}`,reason:'Customer care grant'}));
  assert.equal(manualOne.created,true);assert.equal(manualOne.entitlement.entitlement_type,'VOUCHER');
  const manualRetry=await db.transaction(client=>issueManualVipEntitlement(client,{tenantId:ids.tenant,storeId:ids.store,customerId:oldEntry.id,benefitRef:benefitRefs.manual,requestKey:`manual-${suffix}`,reason:'Retry of same customer care grant'}));
  assert.equal(manualRetry.created,false,'manual request_key must make retries idempotent');assert.equal(manualRetry.entitlement.id,manualOne.entitlement.id);

  const counts=await db.query(`SELECT frequency,count(*)::int AS count FROM vip_entitlements e JOIN vip_benefits b ON b.id=e.benefit_id WHERE e.tenant_id=$1 AND e.store_id=$2 GROUP BY frequency ORDER BY frequency`,[ids.tenant,ids.store]);
  assert.deepEqual(Object.fromEntries(counts.rows.map(row=>[row.frequency,row.count])),{ANNUAL:2,BIRTHDAY:1,MANUAL:1,MONTHLY:2,TIER_ENTRY:1});
  console.log('PASS recurring issuance defaults off, keyset-paginates every member, issues deterministic monthly/annual/birthday/tier-entry entitlements, prevents tier-entry backfill, and remains idempotent');
  console.log('PASS manual VIP entitlement retry keys prevent duplicate customer grants');
}finally{
  await db.query('DELETE FROM tenants WHERE id=$1',[ids.tenant]).catch(()=>{});
  await db.close().catch(()=>{});
}
