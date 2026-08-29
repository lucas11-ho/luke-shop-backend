import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';

const upper=value=>String(value||'').trim().toUpperCase();
const numberOrNull=value=>value===null||value===undefined||value===''?null:Number(value);
const money=value=>Number(Number(value||0).toFixed(4));

export function vipPeriodWindow(program,now=new Date()){
  const end=new Date(now);
  let start=null;
  const period=upper(program?.evaluation_period||'LIFETIME');
  const rolling={ROLLING_30:30,ROLLING_90:90,ROLLING_180:180,ROLLING_365:365};
  if(rolling[period]) start=new Date(end.getTime()-rolling[period]*86400000);
  else if(period==='CUSTOM') start=new Date(end.getTime()-Number(program.custom_period_days||1)*86400000);
  else if(period==='CALENDAR_YEAR') start=new Date(Date.UTC(end.getUTCFullYear(),0,1));
  return {start:start?.toISOString()||null,end:end.toISOString()};
}

export async function getVipProgram(db,tenantId,storeId){
  const result=await db.query(`SELECT vp.public_id AS id,vp.id AS internal_id,vp.enabled,vp.evaluation_period,vp.custom_period_days,
      vp.evaluation_frequency,vp.downgrade_policy,vp.grace_days,vp.created_at,vp.updated_at,s.currency
    FROM vip_programs vp JOIN stores s ON s.id=vp.store_id AND s.tenant_id=vp.tenant_id
    WHERE vp.tenant_id=$1 AND vp.store_id=$2`,[tenantId,storeId]);
  return result.rows[0]||null;
}

export async function listVipLevels(db,tenantId,storeId,{activeOnly=false}={}){
  const result=await db.query(`SELECT public_id AS id,id AS internal_id,code,name,description,badge_icon,badge_color,status,sort_order,
      qualification_mode,spend_threshold,order_threshold,created_at,updated_at
    FROM vip_levels WHERE tenant_id=$1 AND store_id=$2 ${activeOnly?"AND status='ACTIVE'":''}
    ORDER BY sort_order,created_at,id`,[tenantId,storeId]);
  return result.rows;
}

export async function listVipBenefits(db,tenantId,storeId,{levelId=null,activeOnly=false}={}){
  const values=[tenantId,storeId];
  let where='WHERE b.tenant_id=$1 AND b.store_id=$2';
  if(levelId){values.push(levelId);where+=` AND l.public_id=$${values.length}`;}
  if(activeOnly) where+=" AND b.status='ACTIVE' AND l.status='ACTIVE'";
  const result=await db.query(`SELECT b.public_id AS id,b.id AS internal_id,l.public_id AS level_id,l.name AS level_name,l.code AS level_code,
      b.name,b.benefit_type,b.frequency,b.status,b.config,b.sort_order,b.created_at,b.updated_at
    FROM vip_benefits b JOIN vip_levels l ON l.id=b.level_id AND l.tenant_id=b.tenant_id AND l.store_id=b.store_id
    ${where} ORDER BY l.sort_order,b.sort_order,b.created_at,b.id`,values);
  return result.rows;
}

export function validateVipLevel(input,current={}){
  const mode=upper(input.qualification_mode??current.qualification_mode);
  const spend=numberOrNull(input.spend_threshold!==undefined?input.spend_threshold:current.spend_threshold);
  const orders=numberOrNull(input.order_threshold!==undefined?input.order_threshold:current.order_threshold);
  if(!['SPEND','ORDERS','AND','OR'].includes(mode)) throw errors.badRequest('VIP_QUALIFICATION_MODE_INVALID','Unsupported VIP qualification mode');
  if(spend!==null&&(!Number.isFinite(spend)||spend<0)) throw errors.badRequest('VIP_SPEND_THRESHOLD_INVALID','Spend threshold must be zero or greater');
  if(orders!==null&&(!Number.isInteger(orders)||orders<0)) throw errors.badRequest('VIP_ORDER_THRESHOLD_INVALID','Order threshold must be a non-negative integer');
  if(mode==='SPEND'&&spend===null) throw errors.badRequest('VIP_SPEND_THRESHOLD_REQUIRED','Spend threshold is required');
  if(mode==='ORDERS'&&orders===null) throw errors.badRequest('VIP_ORDER_THRESHOLD_REQUIRED','Order threshold is required');
  if(['AND','OR'].includes(mode)&&(spend===null||orders===null)) throw errors.badRequest('VIP_THRESHOLDS_REQUIRED','Spend and order thresholds are required');
  return {qualification_mode:mode,spend_threshold:spend,order_threshold:orders};
}

export function normalizeBenefitConfig(type,input={}){
  const t=upper(type),config=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
  const nonNegative=(key,{nullable=true}={})=>{const raw=config[key];if(raw===undefined||raw===null||raw==='')return nullable?null:0;const n=Number(raw);if(!Number.isFinite(n)||n<0)throw errors.badRequest('VIP_BENEFIT_CONFIG_INVALID',`${key} must be zero or greater`);return n;};
  const positiveInt=key=>{const raw=config[key];if(raw===undefined||raw===null||raw==='')return null;const n=Number(raw);if(!Number.isInteger(n)||n<=0)throw errors.badRequest('VIP_BENEFIT_CONFIG_INVALID',`${key} must be a positive integer`);return n;};
  if(t==='FREE_DELIVERY') return {min_order:nonNegative('min_order',{nullable:false}),max_subsidy:nonNegative('max_subsidy'),usage_limit:positiveInt('usage_limit'),delivery_method_ids:Array.isArray(config.delivery_method_ids)?[...new Set(config.delivery_method_ids.map(String).filter(Boolean))]:[]};
  if(t==='CASHBACK'){
    const value_type=upper(config.value_type||'PERCENTAGE');if(!['PERCENTAGE','FIXED'].includes(value_type))throw errors.badRequest('VIP_BENEFIT_CONFIG_INVALID','Cashback value_type must be PERCENTAGE or FIXED');
    const value=Number(config.value);if(!Number.isFinite(value)||value<=0||(value_type==='PERCENTAGE'&&value>100))throw errors.badRequest('VIP_BENEFIT_CONFIG_INVALID','Cashback value is invalid');
    return {value_type,value,min_order:nonNegative('min_order',{nullable:false}),value,cap:nonNegative('cap'),expires_days:positiveInt('expires_days')};
  }
  if(t==='VOUCHER'){
    const discount_type=upper(config.discount_type||'FIXED');if(!['PERCENTAGE','FIXED'].includes(discount_type))throw errors.badRequest('VIP_BENEFIT_CONFIG_INVALID','Voucher discount_type must be PERCENTAGE or FIXED');
    const value=Number(config.value);if(!Number.isFinite(value)||value<=0||(discount_type==='PERCENTAGE'&&value>100))throw errors.badRequest('VIP_BENEFIT_CONFIG_INVALID','Voucher value is invalid');
    return {discount_type,value,min_order:nonNegative('min_order',{nullable:false}),max_discount:nonNegative('max_discount'),validity_days:positiveInt('validity_days')};
  }
  if(t==='GIFT'){
    const product_id=config.product_id?String(config.product_id):null,present_name=config.present_name?String(config.present_name).trim():'';
    if(!product_id&&!present_name)throw errors.badRequest('VIP_BENEFIT_CONFIG_INVALID','Gift requires a product_id or present_name');
    return {product_id,present_name:present_name||null,notes:config.notes?String(config.notes).slice(0,500):null};
  }
  throw errors.badRequest('VIP_BENEFIT_TYPE_INVALID','Unsupported VIP benefit type');
}

export async function qualificationMetrics(db,{tenantId,storeId,customerId,program,now=new Date()}){
  const window=vipPeriodWindow(program,now);
  const values=[tenantId,storeId,customerId];
  let period='';
  if(window.start){values.push(window.start);period+=` AND e.completed_at >= $${values.length}::timestamptz`;}
  values.push(window.end);period+=` AND e.completed_at <= $${values.length}::timestamptz`;
  const result=await db.query(`WITH eligible AS (
    SELECT o.id,GREATEST(o.grand_total-COALESCE(op.refunded_amount,0),0)::numeric AS net_total,
      COALESCE((SELECT max(h.created_at) FROM order_status_history h WHERE h.tenant_id=o.tenant_id AND h.store_id=o.store_id AND h.order_id=o.id AND h.to_status='COMPLETED'),CASE WHEN o.status='COMPLETED' THEN o.updated_at ELSE NULL END) AS completed_at
    FROM orders o JOIN order_payments op ON op.tenant_id=o.tenant_id AND op.store_id=o.store_id AND op.order_id=o.id
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.customer_id=$3 AND op.paid_at IS NOT NULL
  ) SELECT COALESCE(sum(e.net_total) FILTER (WHERE e.net_total>0 ${period}),0)::numeric AS qualified_spend,
      count(*) FILTER (WHERE e.net_total>0 ${period})::int AS qualified_orders
    FROM eligible e WHERE e.completed_at IS NOT NULL`,values);
  return {qualified_spend:money(result.rows[0]?.qualified_spend),qualified_orders:Number(result.rows[0]?.qualified_orders||0),evaluation_start:window.start,evaluation_end:window.end};
}

export function levelQualifies(level,metrics){
  const spend=Number(metrics.qualified_spend||0),orders=Number(metrics.qualified_orders||0),spendOk=spend>=Number(level.spend_threshold||0),ordersOk=orders>=Number(level.order_threshold||0);
  if(level.qualification_mode==='SPEND')return spendOk;
  if(level.qualification_mode==='ORDERS')return ordersOk;
  if(level.qualification_mode==='AND')return spendOk&&ordersOk;
  return spendOk||ordersOk;
}

export function bestQualifiedLevel(levels,metrics){
  return levels.filter(level=>levelQualifies(level,metrics)).sort((a,b)=>Number(a.sort_order)-Number(b.sort_order)||String(a.created_at).localeCompare(String(b.created_at))).at(-1)||null;
}

async function currentStatus(db,tenantId,storeId,customerId,{lock=false}={}){
  const result=await db.query(`SELECT cvs.*,l.public_id AS level_public_id,l.name AS level_name,l.code AS level_code,l.sort_order AS level_sort_order
    FROM customer_vip_status cvs LEFT JOIN vip_levels l ON l.id=cvs.level_id AND l.tenant_id=cvs.tenant_id AND l.store_id=cvs.store_id
    WHERE cvs.tenant_id=$1 AND cvs.store_id=$2 AND cvs.customer_id=$3 ${lock?'FOR UPDATE OF cvs':''}`,[tenantId,storeId,customerId]);
  return result.rows[0]||null;
}

export async function evaluateCustomerVip(db,{tenantId,storeId,customerId,actorType='SYSTEM',actorId=null,source='EVALUATION',reason='VIP qualification evaluation',now=new Date()}){
  const program=await getVipProgram(db,tenantId,storeId);if(!program)throw errors.notFound('VIP_PROGRAM_NOT_FOUND','VIP program not found');
  const customer=await db.query(`SELECT id,public_id,display_name,customer_code FROM customers WHERE tenant_id=$1 AND id=$2`,[tenantId,customerId]);if(!customer.rowCount)throw errors.notFound('CUSTOMER_NOT_FOUND','Customer not found');
  const metrics=await qualificationMetrics(db,{tenantId,storeId,customerId,program,now});
  const levels=await listVipLevels(db,tenantId,storeId,{activeOnly:true});
  const candidate=program.enabled?bestQualifiedLevel(levels,metrics):null;
  const current=await currentStatus(db,tenantId,storeId,customerId,{lock:true});
  const expired=current?.tier_expires_at&&new Date(current.tier_expires_at)<=now;
  if(current?.locked&&!expired){
    await db.query(`UPDATE customer_vip_status SET qualified_spend=$1,qualified_orders=$2,evaluation_start=$3,evaluation_end=$4,evaluated_at=$5,updated_at=now() WHERE id=$6`,[metrics.qualified_spend,metrics.qualified_orders,metrics.evaluation_start,metrics.evaluation_end,now,current.id]);
    return {status:{...current,...metrics,evaluated_at:now.toISOString()},candidate,program,locked:true};
  }
  let target=candidate,graceUntil=null;
  const currentLevel=current?.level_id?levels.find(level=>level.internal_id===current.level_id)||{internal_id:current.level_id,sort_order:Number(current.level_sort_order||0),id:current.level_public_id,name:current.level_name,code:current.level_code}:null;
  const isDowngrade=currentLevel&&(!candidate||Number(candidate.sort_order)<Number(currentLevel.sort_order));
  if(isDowngrade&&program.downgrade_policy==='NEVER') target=currentLevel;
  else if(isDowngrade&&Number(program.grace_days)>0){
    if(current?.grace_until&&new Date(current.grace_until)>now){target=currentLevel;graceUntil=current.grace_until;}
    else if(!current?.grace_until){target=currentLevel;graceUntil=new Date(now.getTime()+Number(program.grace_days)*86400000).toISOString();}
  }
  const changed=(current?.level_id||null)!==(target?.internal_id||null);
  const pid=current?.public_id||publicId('vipm');
  if(current){
    await db.query(`UPDATE customer_vip_status SET level_id=$1,assignment_source='AUTO',locked=false,qualified_spend=$2,qualified_orders=$3,evaluation_start=$4,evaluation_end=$5,tier_expires_at=NULL,grace_until=$6,evaluated_at=$7,updated_at=now() WHERE id=$8`,[target?.internal_id||null,metrics.qualified_spend,metrics.qualified_orders,metrics.evaluation_start,metrics.evaluation_end,graceUntil,now,current.id]);
  }else{
    await db.query(`INSERT INTO customer_vip_status(id,public_id,tenant_id,store_id,customer_id,level_id,assignment_source,locked,qualified_spend,qualified_orders,evaluation_start,evaluation_end,grace_until,evaluated_at) VALUES($1,$2,$3,$4,$5,$6,'AUTO',false,$7,$8,$9,$10,$11,$12)`,[uuid(),pid,tenantId,storeId,customerId,target?.internal_id||null,metrics.qualified_spend,metrics.qualified_orders,metrics.evaluation_start,metrics.evaluation_end,graceUntil,now]);
  }
  if(changed){await db.query(`INSERT INTO vip_tier_history(tenant_id,store_id,customer_id,from_level_id,to_level_id,source,reason,actor_type,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[tenantId,storeId,customerId,current?.level_id||null,target?.internal_id||null,expired?'EXPIRY':source,reason,actorType,actorId]);}
  return {status:await currentStatus(db,tenantId,storeId,customerId),candidate,program,locked:false,changed};
}

export async function vipMemberDetail(db,{tenantId,storeId,customerRef}){
  const customer=await db.query(`SELECT id,public_id,customer_code,display_name,email,phone_e164,status,created_at FROM customers WHERE tenant_id=$1 AND (public_id=$2 OR customer_code=$2)`,[tenantId,customerRef]);
  if(!customer.rowCount)throw errors.notFound('CUSTOMER_NOT_FOUND','Customer not found');
  const c=customer.rows[0],program=await getVipProgram(db,tenantId,storeId),status=await currentStatus(db,tenantId,storeId,c.id),metrics=program?await qualificationMetrics(db,{tenantId,storeId,customerId:c.id,program}):null,levels=await listVipLevels(db,tenantId,storeId,{activeOnly:true});
  const level=status?.level_id?levels.find(x=>x.internal_id===status.level_id)||null:null;
  const nextLevel=levels.find(x=>Number(x.sort_order)>Number(level?.sort_order??-Infinity))||null;
  const history=await db.query(`SELECT h.source,h.reason,h.actor_type,h.created_at,fl.public_id AS from_level_id,fl.name AS from_level_name,tl.public_id AS to_level_id,tl.name AS to_level_name
    FROM vip_tier_history h LEFT JOIN vip_levels fl ON fl.id=h.from_level_id LEFT JOIN vip_levels tl ON tl.id=h.to_level_id
    WHERE h.tenant_id=$1 AND h.store_id=$2 AND h.customer_id=$3 ORDER BY h.created_at DESC,h.id DESC LIMIT 100`,[tenantId,storeId,c.id]);
  const benefits=level?await listVipBenefits(db,tenantId,storeId,{levelId:level.id,activeOnly:true}):[];
  return {customer:{...c,id:c.public_id},program,status:status?{id:status.public_id,level_id:level?.id||status.level_public_id||null,level_name:level?.name||status.level_name||null,assignment_source:status.assignment_source,locked:status.locked,qualified_spend:money(status.qualified_spend),qualified_orders:Number(status.qualified_orders||0),evaluation_start:status.evaluation_start,evaluation_end:status.evaluation_end,tier_expires_at:status.tier_expires_at,grace_until:status.grace_until,evaluated_at:status.evaluated_at}:null,live_metrics:metrics,current_level:level,next_level:nextLevel,benefits,history:history.rows};
}

export async function vipOverview(db,{tenantId,storeId}){
  const program=await getVipProgram(db,tenantId,storeId),levels=await listVipLevels(db,tenantId,storeId),benefits=await listVipBenefits(db,tenantId,storeId);
  const totals=await db.query(`SELECT count(*) FILTER (WHERE level_id IS NOT NULL)::int AS members,count(*) FILTER (WHERE level_id IS NULL)::int AS evaluated_without_level,
    COALESCE(sum(qualified_spend),0)::numeric AS qualified_spend,COALESCE(sum(qualified_orders),0)::bigint AS qualified_orders,count(*) FILTER (WHERE locked)::int AS locked_members
    FROM customer_vip_status WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);
  const byLevel=await db.query(`SELECT l.public_id AS level_id,l.name,l.code,l.badge_color,l.sort_order,count(cvs.id)::int AS members,COALESCE(sum(cvs.qualified_spend),0)::numeric AS qualified_spend
    FROM vip_levels l LEFT JOIN customer_vip_status cvs ON cvs.tenant_id=l.tenant_id AND cvs.store_id=l.store_id AND cvs.level_id=l.id
    WHERE l.tenant_id=$1 AND l.store_id=$2 GROUP BY l.id ORDER BY l.sort_order,l.created_at`,[tenantId,storeId]);
  const movements=await db.query(`SELECT
    count(*) FILTER (WHERE tl.id IS NOT NULL AND (fl.id IS NULL OR tl.sort_order>fl.sort_order))::int AS upgrades,
    count(*) FILTER (WHERE fl.id IS NOT NULL AND (tl.id IS NULL OR tl.sort_order<fl.sort_order))::int AS downgrades
    FROM vip_tier_history h LEFT JOIN vip_levels fl ON fl.id=h.from_level_id LEFT JOIN vip_levels tl ON tl.id=h.to_level_id
    WHERE h.tenant_id=$1 AND h.store_id=$2 AND h.created_at>=now()-interval '30 days'`,[tenantId,storeId]);
  return {program,levels,benefits,metrics:{members:Number(totals.rows[0]?.members||0),evaluated_without_level:Number(totals.rows[0]?.evaluated_without_level||0),qualified_spend:money(totals.rows[0]?.qualified_spend),qualified_orders:Number(totals.rows[0]?.qualified_orders||0),locked_members:Number(totals.rows[0]?.locked_members||0),upgrades_30d:Number(movements.rows[0]?.upgrades||0),downgrades_30d:Number(movements.rows[0]?.downgrades||0),active_benefits:benefits.filter(b=>b.status==='ACTIVE').length},by_level:byLevel.rows.map(row=>({...row,qualified_spend:money(row.qualified_spend)}))};
}
