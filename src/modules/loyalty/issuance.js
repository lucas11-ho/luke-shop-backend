import { errors } from '../../core/errors.js';
import { createVipEntitlement, expireDueVipEntitlements } from './execution.js';

const upper=value=>String(value||'').trim().toUpperCase();
const ENTITLEMENT_TYPES=new Set(['VOUCHER','GIFT']);
const RECURRING_FREQUENCIES=new Set(['TIER_ENTRY','MONTHLY','ANNUAL','BIRTHDAY']);
const NON_ORDER_FREQUENCIES=new Set([...RECURRING_FREQUENCIES,'MANUAL']);

function safeTimeZone(value){
  const requested=String(value||'UTC').trim()||'UTC';
  try{new Intl.DateTimeFormat('en-US',{timeZone:requested}).format(new Date());return requested;}catch{return'UTC';}
}

function localDateParts(now,timeZone){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:safeTimeZone(timeZone),year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get=type=>parts.find(part=>part.type===type)?.value||'';
  return {year:get('year'),month:get('month'),day:get('day')};
}

function birthMonthDay(value){
  if(!value)return null;
  const match=String(value).match(/^\d{4}-(\d{2})-(\d{2})/);
  return match?`${match[1]}-${match[2]}`:null;
}

export function assertVipBenefitFrequency(type,frequency){
  const t=upper(type),f=upper(frequency);
  if(NON_ORDER_FREQUENCIES.has(f)&&!ENTITLEMENT_TYPES.has(t)){
    throw errors.badRequest('VIP_BENEFIT_FREQUENCY_UNSUPPORTED',`${f} is supported only for VOUCHER or GIFT benefits`);
  }
  return {benefit_type:t,frequency:f};
}

export async function recurringVipIssuancePolicy(db,{tenantId,storeId}){
  const result=await db.query(`SELECT vp.enabled AS program_enabled,vp.recurring_entitlement_issuance_enabled,
      vp.recurring_entitlement_issuance_enabled_at,ts.timezone
    FROM vip_programs vp JOIN tenant_settings ts ON ts.tenant_id=vp.tenant_id
    WHERE vp.tenant_id=$1 AND vp.store_id=$2`,[tenantId,storeId]);
  if(!result.rowCount)throw errors.notFound('VIP_PROGRAM_NOT_FOUND','VIP program not found');
  const row=result.rows[0];
  return {
    program_enabled:!!row.program_enabled,
    recurring_entitlement_issuance_enabled:!!row.recurring_entitlement_issuance_enabled,
    enabled:!!row.program_enabled&&!!row.recurring_entitlement_issuance_enabled,
    enabled_at:row.recurring_entitlement_issuance_enabled_at||null,
    timezone:safeTimeZone(row.timezone),
  };
}

function issuanceDecision({benefit,member,entryHistory,policy,local}){
  const frequency=upper(benefit.frequency);
  const customerRef=member.customer_public_id;
  if(frequency==='MONTHLY')return {period:`${local.year}-${local.month}`,key:`MONTHLY:${local.year}-${local.month}:CUSTOMER:${customerRef}:BENEFIT:${benefit.public_id}`};
  if(frequency==='ANNUAL')return {period:local.year,key:`ANNUAL:${local.year}:CUSTOMER:${customerRef}:BENEFIT:${benefit.public_id}`};
  if(frequency==='BIRTHDAY'){
    if(birthMonthDay(member.birth_date)!==`${local.month}-${local.day}`)return null;
    return {period:local.year,key:`BIRTHDAY:${local.year}:CUSTOMER:${customerRef}:BENEFIT:${benefit.public_id}`};
  }
  if(frequency==='TIER_ENTRY'){
    const history=entryHistory.get(`${member.customer_id}:${member.level_id}`);if(!history)return null;
    if(!policy.enabled_at||new Date(history.created_at)<new Date(policy.enabled_at))return null;
    return {period:`tier-history-${history.id}`,key:`TIER_ENTRY:${history.id}:CUSTOMER:${customerRef}:BENEFIT:${benefit.public_id}`};
  }
  return null;
}

export async function runRecurringVipEntitlements(client,{tenantId,storeId,now=new Date(),limit=5000}){
  const policy=await recurringVipIssuancePolicy(client,{tenantId,storeId});
  const bounded=Math.min(5000,Math.max(1,Number(limit)||5000));
  const summary={enabled:policy.enabled,timezone:policy.timezone,processed_members:0,issued:0,already_issued:0,expired:0,by_frequency:{TIER_ENTRY:0,MONTHLY:0,ANNUAL:0,BIRTHDAY:0}};
  if(!policy.enabled)return summary;
  summary.expired=await expireDueVipEntitlements(client,{tenantId,storeId});

  const benefits=await client.query(`SELECT b.id,b.public_id,b.level_id,b.name,b.benefit_type,b.frequency,b.config
    FROM vip_benefits b JOIN vip_levels l ON l.id=b.level_id AND l.tenant_id=b.tenant_id AND l.store_id=b.store_id
    WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.status='ACTIVE' AND l.status='ACTIVE'
      AND b.benefit_type IN ('VOUCHER','GIFT') AND b.frequency IN ('TIER_ENTRY','MONTHLY','ANNUAL','BIRTHDAY')
    ORDER BY b.level_id,b.sort_order,b.created_at,b.id`,[tenantId,storeId]);
  if(!benefits.rowCount)return summary;
  const benefitsByLevel=new Map();
  for(const benefit of benefits.rows){const list=benefitsByLevel.get(benefit.level_id)||[];list.push(benefit);benefitsByLevel.set(benefit.level_id,list);}

  const members=await client.query(`SELECT cvs.customer_id,c.public_id AS customer_public_id,c.birth_date,cvs.level_id
    FROM customer_vip_status cvs
    JOIN customers c ON c.id=cvs.customer_id AND c.tenant_id=cvs.tenant_id AND c.status='ACTIVE'
    JOIN vip_levels l ON l.id=cvs.level_id AND l.tenant_id=cvs.tenant_id AND l.store_id=cvs.store_id AND l.status='ACTIVE'
    WHERE cvs.tenant_id=$1 AND cvs.store_id=$2
    ORDER BY cvs.customer_id LIMIT $3`,[tenantId,storeId,bounded]);
  summary.processed_members=members.rowCount;
  if(!members.rowCount)return summary;

  const tierEntries=await client.query(`SELECT DISTINCT ON (h.customer_id,h.to_level_id) h.id,h.customer_id,h.to_level_id,h.created_at
    FROM vip_tier_history h
    JOIN customer_vip_status cvs ON cvs.tenant_id=h.tenant_id AND cvs.store_id=h.store_id AND cvs.customer_id=h.customer_id AND cvs.level_id=h.to_level_id
    WHERE h.tenant_id=$1 AND h.store_id=$2 AND h.to_level_id IS NOT NULL
    ORDER BY h.customer_id,h.to_level_id,h.id DESC`,[tenantId,storeId]);
  const entryHistory=new Map(tierEntries.rows.map(row=>[`${row.customer_id}:${row.to_level_id}`,row]));
  const local=localDateParts(now,policy.timezone);

  for(const member of members.rows){
    for(const benefit of benefitsByLevel.get(member.level_id)||[]){
      const decision=issuanceDecision({benefit,member,entryHistory,policy,local});if(!decision)continue;
      const payload={...(benefit.config||{}),issuance_frequency:benefit.frequency,issuance_period:decision.period};
      const entitlement=await createVipEntitlement(client,{tenantId,storeId,customerId:member.customer_id,levelId:member.level_id,benefitId:benefit.id,orderId:null,type:benefit.benefit_type,config:payload,issuanceKey:decision.key});
      if(entitlement){summary.issued++;summary.by_frequency[benefit.frequency]=(summary.by_frequency[benefit.frequency]||0)+1;}
      else summary.already_issued++;
    }
  }
  return summary;
}

export async function issueManualVipEntitlement(client,{tenantId,storeId,customerId,benefitRef,requestKey,reason}){
  const program=await client.query(`SELECT enabled FROM vip_programs WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);
  if(!program.rowCount)throw errors.notFound('VIP_PROGRAM_NOT_FOUND','VIP program not found');
  if(!program.rows[0].enabled)throw errors.conflict('VIP_PROGRAM_DISABLED','VIP program must be enabled before issuing a manual entitlement');
  const result=await client.query(`SELECT c.public_id AS customer_public_id,c.status AS customer_status,cvs.level_id,
      b.id AS benefit_id,b.public_id AS benefit_public_id,b.name,b.benefit_type,b.frequency,b.config
    FROM customers c
    JOIN customer_vip_status cvs ON cvs.tenant_id=c.tenant_id AND cvs.customer_id=c.id AND cvs.store_id=$2
    JOIN vip_levels l ON l.id=cvs.level_id AND l.tenant_id=cvs.tenant_id AND l.store_id=cvs.store_id AND l.status='ACTIVE'
    JOIN vip_benefits b ON b.level_id=l.id AND b.tenant_id=l.tenant_id AND b.store_id=l.store_id AND b.status='ACTIVE'
    WHERE c.tenant_id=$1 AND c.id=$3 AND b.public_id=$4`,[tenantId,storeId,customerId,benefitRef]);
  if(!result.rowCount)throw errors.notFound('VIP_MANUAL_BENEFIT_NOT_FOUND','Manual entitlement benefit is not available on the customer current VIP level');
  const row=result.rows[0];
  if(row.customer_status!=='ACTIVE')throw errors.conflict('CUSTOMER_NOT_ACTIVE','Manual VIP entitlement can be issued only to an active customer');
  if(row.frequency!=='MANUAL'||!ENTITLEMENT_TYPES.has(row.benefit_type))throw errors.badRequest('VIP_MANUAL_BENEFIT_INVALID','Selected benefit must be an active MANUAL VOUCHER or GIFT on the current VIP level');
  const normalizedKey=String(requestKey||'').trim();
  if(!/^[A-Za-z0-9._:-]{8,120}$/.test(normalizedKey))throw errors.badRequest('VIP_MANUAL_REQUEST_KEY_INVALID','Manual issuance request_key must be 8-120 safe characters');
  const issuanceKey=`MANUAL:${normalizedKey}:CUSTOMER:${row.customer_public_id}:BENEFIT:${row.benefit_public_id}`;
  const payload={...(row.config||{}),issuance_frequency:'MANUAL',manual_reason:String(reason||'').trim()};
  const entitlementId=await createVipEntitlement(client,{tenantId,storeId,customerId,levelId:row.level_id,benefitId:row.benefit_id,orderId:null,type:row.benefit_type,config:payload,issuanceKey});
  const entitlement=await client.query(`SELECT e.public_id AS id,e.entitlement_type,e.status,e.redeem_code,e.payload_snapshot,e.valid_from,e.expires_at,e.issued_at,
      b.public_id AS benefit_id,b.name AS benefit_name
    FROM vip_entitlements e JOIN vip_benefits b ON b.id=e.benefit_id AND b.tenant_id=e.tenant_id AND b.store_id=e.store_id
    WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.issuance_key=$3`,[tenantId,storeId,issuanceKey]);
  return {created:!!entitlementId,entitlement:entitlement.rows[0]||null};
}
