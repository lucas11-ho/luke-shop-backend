import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const DEFAULTS={enabled:true,require_online_for_assignment:false,max_active_jobs:3,location_mode:'AUTO_ON_START_DELIVERY',location_update_seconds:10,tracking_stale_seconds:45,proof_policy:'ANY',cod_enabled:true,max_cod_held:null,allow_customer_call:true,allow_customer_chat:true,allow_store_chat:true,chat_close_minutes:60,quick_replies:['I am on my way.','I have arrived.','I cannot find your location.','Please come to the entrance.','There is a small delay.'],supported_locales:['en','my']};
const settingsSelect=`SELECT enabled,require_online_for_assignment,max_active_jobs,location_mode,location_update_seconds,tracking_stale_seconds,proof_policy,cod_enabled,max_cod_held,allow_customer_call,allow_customer_chat,allow_store_chat,chat_close_minutes,quick_replies,supported_locales,created_at,updated_at FROM delivery_driver_app_settings WHERE tenant_id=$1 AND store_id=$2`;

async function storeFor(app,request,{active=true}={}){return resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:active});}
async function driverContext(app,request){
 const store=await storeFor(app,request);
 const found=await app.db.query(`SELECT d.*,mu.public_id AS merchant_user_public_id,mu.email AS merchant_user_email FROM delivery_drivers d JOIN merchant_users mu ON mu.id=d.merchant_user_id AND mu.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.merchant_user_id=$3 AND d.status='ACTIVE'`,[request.auth.tenantId,store.id,request.auth.actorId]);
 if(!found.rowCount)throw errors.forbidden('DRIVER_PROFILE_REQUIRED','This merchant account is not linked to an active driver for the selected store');
 return {store,driver:found.rows[0]};
}
async function readSettings(db,tenantId,storeId){const row=await db.query(settingsSelect,[tenantId,storeId]);return row.rows[0]||{...DEFAULTS,created_at:null,updated_at:null};}

export async function driverAppRoutes(app){
 const merchantRead=[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.DELIVERY_READ)];
 const merchantManage=[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.DELIVERY_MANAGE)];
 const driverAuth=[app.requireMerchantAuth];

 app.get('/v1/merchant/delivery/driver-app/settings',{preHandler:merchantRead},async request=>{
  const store=await storeFor(app,request,{active:false});return {data:{settings:await readSettings(app.db,request.auth.tenantId,store.id)}};
 });

 app.put('/v1/merchant/delivery/driver-app/settings',{preHandler:merchantManage,schema:{body:{type:'object',additionalProperties:false,properties:{enabled:{type:'boolean'},require_online_for_assignment:{type:'boolean'},max_active_jobs:{type:'integer',minimum:1,maximum:25},location_mode:{type:'string',enum:['AUTO_ON_START_DELIVERY','MANUAL']},location_update_seconds:{type:'integer',minimum:5,maximum:120},tracking_stale_seconds:{type:'integer',minimum:15,maximum:600},proof_policy:{type:'string',enum:['ANY','ACKNOWLEDGEMENT','PHOTO','PHOTO_AND_ACKNOWLEDGEMENT']},cod_enabled:{type:'boolean'},max_cod_held:{type:['number','null'],minimum:0},allow_customer_call:{type:'boolean'},allow_customer_chat:{type:'boolean'},allow_store_chat:{type:'boolean'},chat_close_minutes:{type:'integer',minimum:0,maximum:10080},quick_replies:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:180}},supported_locales:{type:'array',minItems:1,maxItems:10,items:{type:'string',minLength:2,maxLength:12}}}}}},async request=>{
  const store=await storeFor(app,request,{active:false}),current=await readSettings(app.db,request.auth.tenantId,store.id),b=request.body||{};
  const next={...current,...b,quick_replies:b.quick_replies!==undefined?[...new Set(b.quick_replies.map(v=>String(v).trim()).filter(Boolean))]:current.quick_replies,supported_locales:b.supported_locales!==undefined?[...new Set(b.supported_locales.map(v=>String(v).trim().toLowerCase()).filter(Boolean))]:current.supported_locales};
  await app.db.transaction(async client=>{
   await client.query(`INSERT INTO delivery_driver_app_settings(tenant_id,store_id,enabled,require_online_for_assignment,max_active_jobs,location_mode,location_update_seconds,tracking_stale_seconds,proof_policy,cod_enabled,max_cod_held,allow_customer_call,allow_customer_chat,allow_store_chat,chat_close_minutes,quick_replies,supported_locales,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$18) ON CONFLICT(tenant_id,store_id) DO UPDATE SET enabled=EXCLUDED.enabled,require_online_for_assignment=EXCLUDED.require_online_for_assignment,max_active_jobs=EXCLUDED.max_active_jobs,location_mode=EXCLUDED.location_mode,location_update_seconds=EXCLUDED.location_update_seconds,tracking_stale_seconds=EXCLUDED.tracking_stale_seconds,proof_policy=EXCLUDED.proof_policy,cod_enabled=EXCLUDED.cod_enabled,max_cod_held=EXCLUDED.max_cod_held,allow_customer_call=EXCLUDED.allow_customer_call,allow_customer_chat=EXCLUDED.allow_customer_chat,allow_store_chat=EXCLUDED.allow_store_chat,chat_close_minutes=EXCLUDED.chat_close_minutes,quick_replies=EXCLUDED.quick_replies,supported_locales=EXCLUDED.supported_locales,updated_by=EXCLUDED.updated_by,updated_at=now()`,[request.auth.tenantId,store.id,next.enabled,next.require_online_for_assignment,next.max_active_jobs,next.location_mode,next.location_update_seconds,next.tracking_stale_seconds,next.proof_policy,next.cod_enabled,next.max_cod_held,next.allow_customer_call,next.allow_customer_chat,next.allow_store_chat,next.chat_close_minutes,JSON.stringify(next.quick_replies),next.supported_locales,request.auth.actorId]);
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'delivery.driver_app.settings.update',targetType:'store',targetId:store.id,metadata:{enabled:next.enabled,require_online_for_assignment:next.require_online_for_assignment,max_active_jobs:next.max_active_jobs,location_mode:next.location_mode,proof_policy:next.proof_policy,cod_enabled:next.cod_enabled},requestIp:request.ip,requestId:request.id});
  });
  return {data:{settings:await readSettings(app.db,request.auth.tenantId,store.id)}};
 });

 app.get('/v1/driver/app',{preHandler:driverAuth},async request=>{
  const {store,driver}=await driverContext(app,request),settings=await readSettings(app.db,request.auth.tenantId,store.id);
  const [counts,cash]=await Promise.all([
   app.db.query(`SELECT count(*) FILTER (WHERE status NOT IN ('DELIVERED','CANCELLED'))::int AS active_jobs,count(*) FILTER (WHERE status='ASSIGNED')::int AS new_jobs,count(*) FILTER (WHERE status='OUT_FOR_DELIVERY')::int AS on_route,count(*) FILTER (WHERE status='DELIVERED' AND delivered_at>=date_trunc('day',now()))::int AS delivered_today FROM delivery_dispatches WHERE tenant_id=$1 AND store_id=$2 AND driver_id=$3`,[request.auth.tenantId,store.id,driver.id]),
   app.db.query(`SELECT COALESCE(sum(collected_amount) FILTER (WHERE status='COLLECTED'),0)::numeric AS held_amount,count(*) FILTER (WHERE status='COLLECTED')::int AS held_count,COALESCE(max(currency) FILTER (WHERE status='COLLECTED'),'USD') AS currency FROM delivery_cod_collections WHERE tenant_id=$1 AND store_id=$2 AND driver_id=$3`,[request.auth.tenantId,store.id,driver.id]),
  ]);
  await app.db.query(`UPDATE delivery_drivers SET last_seen_at=now() WHERE id=$1`,[driver.id]);
  return {data:{driver:{id:driver.public_id,display_name:driver.display_name,phone_e164:driver.phone_e164,vehicle_type:driver.vehicle_type,vehicle_label:driver.vehicle_label,availability_status:driver.availability_status,preferred_locale:driver.preferred_locale,availability_updated_at:driver.availability_updated_at,store:{id:store.public_id,name:store.name}},settings,summary:{...counts.rows[0],cash_held:Number(cash.rows[0].held_amount||0),cash_held_count:cash.rows[0].held_count||0,currency:cash.rows[0].currency||'USD'}}};
 });

 app.patch('/v1/driver/availability',{preHandler:driverAuth,schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{status:{type:'string',enum:['ONLINE','BREAK','OFFLINE']},preferred_locale:{type:'string',minLength:2,maxLength:12}}}}},async request=>{
  const {store,driver}=await driverContext(app,request),status=request.body.status||driver.availability_status,locale=(request.body.preferred_locale||driver.preferred_locale||'en').trim().toLowerCase();
  const settings=await readSettings(app.db,request.auth.tenantId,store.id);if(!settings.supported_locales.includes(locale))throw errors.badRequest('DRIVER_LOCALE_NOT_SUPPORTED','Selected Driver App language is not enabled for this store');
  await app.db.transaction(async client=>{
   await client.query(`UPDATE delivery_drivers SET availability_status=$1,preferred_locale=$2,availability_updated_at=CASE WHEN availability_status<>$1 THEN now() ELSE availability_updated_at END,last_seen_at=now(),updated_at=now() WHERE id=$3`,[status,locale,driver.id]);
   if(status!==driver.availability_status)await client.query(`INSERT INTO delivery_driver_presence_events(tenant_id,store_id,driver_id,from_status,to_status,actor_type,actor_id,request_id) VALUES($1,$2,$3,$4,$5,'DRIVER',$6,$7)`,[request.auth.tenantId,store.id,driver.id,driver.availability_status,status,driver.id,request.id]);
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'DRIVER',actorId:driver.id,action:'delivery.driver.presence',targetType:'delivery_driver',targetId:driver.id,metadata:{from_status:driver.availability_status,to_status:status,preferred_locale:locale,merchant_user_id:request.auth.profile.public_id},requestIp:request.ip,requestId:request.id});
  });
  return {data:{driver:{id:driver.public_id,availability_status:status,preferred_locale:locale}}};
 });

 app.get('/v1/driver/cash',{preHandler:driverAuth},async request=>{
  const {store,driver}=await driverContext(app,request);const rows=await app.db.query(`SELECT c.public_id AS id,c.status,c.currency,c.expected_amount,c.collected_amount,c.collected_at,c.remitted_at,c.reconciled_at,o.public_id AS order_id,o.order_number,x.public_id AS dispatch_id FROM delivery_cod_collections c JOIN orders o ON o.id=c.order_id AND o.tenant_id=c.tenant_id AND o.store_id=c.store_id JOIN delivery_dispatches x ON x.id=c.dispatch_id AND x.tenant_id=c.tenant_id AND x.store_id=c.store_id WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.driver_id=$3 ORDER BY CASE c.status WHEN 'COLLECTED' THEN 0 WHEN 'REMITTED' THEN 1 ELSE 2 END,c.collected_at DESC LIMIT 100`,[request.auth.tenantId,store.id,driver.id]);
  const held=rows.rows.filter(r=>r.status==='COLLECTED');return {data:{collections:rows.rows,summary:{held_amount:held.reduce((sum,r)=>sum+Number(r.collected_amount||0),0),held_count:held.length,currency:held[0]?.currency||'USD'}}};
 });
 }
