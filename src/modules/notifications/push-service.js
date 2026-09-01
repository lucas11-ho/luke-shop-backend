import { createHash } from 'node:crypto';
import { loadStaffPushConfig,validatePushEndpoint } from './push-config.js';
import { sendWebPush } from './web-push.js';

const hashEndpoint=value=>createHash('sha256').update(value).digest('hex');
const categoryEnabled=(json,category)=>json?.[category]!==false;
const intersects=(a=[],b=[])=>a.some(value=>b.includes(value));
const includesAll=(have=[],need=[])=>need.every(value=>have.includes(value));

export function validateSubscriptionInput(subscription,config=loadStaffPushConfig()){
 if(!subscription||typeof subscription!=='object')throw new Error('Push subscription is required');
 const endpoint=validatePushEndpoint(subscription.endpoint,config).toString();
 const p256dh=String(subscription.keys?.p256dh||''),authSecret=String(subscription.keys?.auth||'');
 let pub,auth;try{pub=Buffer.from(p256dh,'base64url');auth=Buffer.from(authSecret,'base64url');}catch{throw new Error('Push subscription keys must use base64url encoding');}
 if(pub.length!==65||pub[0]!==4)throw new Error('Push subscription p256dh key is invalid');
 if(auth.length<16||auth.length>64)throw new Error('Push subscription auth secret is invalid');
 return {endpoint,p256dh,authSecret};
}

export async function registerStaffPushSubscription(db,{tenantId,merchantUserId,subscription,deviceLabel=null,userAgent=null,config=loadStaffPushConfig()}){
 const clean=validateSubscriptionInput(subscription,config),endpointHash=hashEndpoint(clean.endpoint),label=String(deviceLabel||'').trim().slice(0,120)||null,agent=String(userAgent||'').trim().slice(0,1000)||null;
 return db.transaction(async client=>{
  const existing=(await client.query(`SELECT id,tenant_id,merchant_user_id,p256dh,auth_secret FROM staff_push_subscriptions WHERE endpoint_hash=$1 FOR UPDATE`,[endpointHash])).rows[0]||null;
  if(existing){
   const sameOwner=String(existing.tenant_id)===String(tenantId)&&String(existing.merchant_user_id)===String(merchantUserId);
   const sameKeys=existing.p256dh===clean.p256dh&&existing.auth_secret===clean.authSecret;
   if(!sameOwner&&!sameKeys)throw new Error('Push endpoint is already registered to another account');
   const row=await client.query(`UPDATE staff_push_subscriptions SET tenant_id=$2,merchant_user_id=$3,endpoint=$4,p256dh=$5,auth_secret=$6,device_label=COALESCE($7,device_label),user_agent=$8,status='ACTIVE',failure_count=0,last_seen_at=now(),disabled_at=NULL,updated_at=now() WHERE id=$1 RETURNING public_id AS id,device_label,status,last_seen_at,last_success_at,created_at`,[existing.id,tenantId,merchantUserId,clean.endpoint,clean.p256dh,clean.authSecret,label,agent]);
   return row.rows[0];
  }
  const row=await client.query(`INSERT INTO staff_push_subscriptions(tenant_id,merchant_user_id,endpoint,endpoint_hash,p256dh,auth_secret,device_label,user_agent,status,failure_count,last_seen_at,disabled_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',0,now(),NULL,now())
   RETURNING public_id AS id,device_label,status,last_seen_at,last_success_at,created_at`,[tenantId,merchantUserId,clean.endpoint,endpointHash,clean.p256dh,clean.authSecret,label,agent]);
  return row.rows[0];
 });
}

export async function listStaffPushDevices(db,{tenantId,merchantUserId}){
 const rows=await db.query(`SELECT public_id AS id,device_label,status,last_seen_at,last_success_at,last_failure_at,failure_count,created_at FROM staff_push_subscriptions WHERE tenant_id=$1 AND merchant_user_id=$2 ORDER BY created_at DESC,id`,[tenantId,merchantUserId]);
 return rows.rows;
}

export async function removeStaffPushDevice(db,{tenantId,merchantUserId,deviceRef}){
 const row=await db.query(`DELETE FROM staff_push_subscriptions WHERE tenant_id=$1 AND merchant_user_id=$2 AND public_id=$3 RETURNING id`,[tenantId,merchantUserId,deviceRef]);
 return row.rowCount>0;
}

export async function readStaffPushPreferences(db,{tenantId,merchantUserId}){
 const row=await db.query(`SELECT enabled,categories,updated_at FROM staff_push_preferences WHERE tenant_id=$1 AND merchant_user_id=$2`,[tenantId,merchantUserId]);
 return row.rows[0]||{enabled:true,categories:{},updated_at:null};
}

export async function saveStaffPushPreferences(db,{tenantId,merchantUserId,enabled,categories}){
 const row=await db.query(`INSERT INTO staff_push_preferences(tenant_id,merchant_user_id,enabled,categories) VALUES($1,$2,$3,$4::jsonb)
  ON CONFLICT(tenant_id,merchant_user_id) DO UPDATE SET enabled=EXCLUDED.enabled,categories=EXCLUDED.categories,updated_at=now()
  RETURNING enabled,categories,updated_at`,[tenantId,merchantUserId,enabled,JSON.stringify(categories||{})]);
 return row.rows[0];
}

export async function readStaffPushStoreSettings(db,{tenantId,storeId}){
 const row=await db.query(`SELECT enabled,categories,updated_at FROM staff_push_store_settings WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);
 return row.rows[0]||{enabled:true,categories:{},updated_at:null};
}

export async function saveStaffPushStoreSettings(db,{tenantId,storeId,enabled,categories,actorId}){
 const row=await db.query(`INSERT INTO staff_push_store_settings(tenant_id,store_id,enabled,categories,updated_by) VALUES($1,$2,$3,$4::jsonb,$5)
  ON CONFLICT(tenant_id,store_id) DO UPDATE SET enabled=EXCLUDED.enabled,categories=EXCLUDED.categories,updated_by=EXCLUDED.updated_by,updated_at=now()
  RETURNING enabled,categories,updated_at`,[tenantId,storeId,enabled,JSON.stringify(categories||{}),actorId]);
 return row.rows[0];
}

export async function queueStaffPushEvent(client,{tenantId,storeId,category,targetUserIds=[],targetRoleKeys=[],targetPermissionKeys=[],permissionMode='ANY',title,body,route,entityType=null,entityRef=null,dedupeKey=null,payload={}}){
 const row=await client.query(`INSERT INTO staff_push_outbox(tenant_id,store_id,category,target_user_ids,target_role_keys,target_permission_keys,permission_mode,title,body,route,entity_type,entity_ref,dedupe_key,payload)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT DO NOTHING RETURNING public_id AS id`,
 [tenantId,storeId,category,targetUserIds,targetRoleKeys,targetPermissionKeys,permissionMode,title,body,route,entityType,entityRef,dedupeKey,JSON.stringify(payload||{})]);
 return row.rows[0]?.id||null;
}

export async function resolvePushRecipients(db,event){
 const settings=await readStaffPushStoreSettings(db,{tenantId:event.tenant_id,storeId:event.store_id});
 if(!settings.enabled||!categoryEnabled(settings.categories,event.category))return[];
 const rows=await db.query(`SELECT s.id,s.public_id,s.endpoint,s.p256dh,s.auth_secret,s.merchant_user_id,mu.public_id AS merchant_user_ref,mu.store_access_mode,
   COALESCE(pref.enabled,true) AS preference_enabled,COALESCE(pref.categories,'{}'::jsonb) AS preference_categories,
   COALESCE(array_agg(DISTINCT r.key) FILTER(WHERE r.key IS NOT NULL),'{}'::text[]) AS roles,
   COALESCE(array_agg(DISTINCT rp.permission_key) FILTER(WHERE rp.permission_key IS NOT NULL),'{}'::text[]) AS permissions
  FROM staff_push_subscriptions s
  JOIN merchant_users mu ON mu.id=s.merchant_user_id AND mu.tenant_id=s.tenant_id
  LEFT JOIN staff_push_preferences pref ON pref.tenant_id=mu.tenant_id AND pref.merchant_user_id=mu.id
  LEFT JOIN merchant_user_roles ur ON ur.tenant_id=mu.tenant_id AND ur.merchant_user_id=mu.id
  LEFT JOIN merchant_roles r ON r.id=ur.role_id AND r.tenant_id=ur.tenant_id
  LEFT JOIN merchant_role_permissions rp ON rp.role_id=r.id
  WHERE s.tenant_id=$1 AND s.status='ACTIVE' AND mu.status='ACTIVE'
    AND (mu.store_access_mode='ALL_STORES' OR EXISTS(SELECT 1 FROM merchant_user_store_access usa WHERE usa.tenant_id=mu.tenant_id AND usa.merchant_user_id=mu.id AND usa.store_id=$2))
  GROUP BY s.id,s.public_id,s.endpoint,s.p256dh,s.auth_secret,s.merchant_user_id,mu.public_id,mu.store_access_mode,pref.enabled,pref.categories`,[event.tenant_id,event.store_id]);
 const targetUsers=(event.target_user_ids||[]).map(String),targetRoles=event.target_role_keys||[],targetPermissions=event.target_permission_keys||[];
 return rows.rows.filter(row=>{
  if(!row.preference_enabled||!categoryEnabled(row.preference_categories,event.category))return false;
  const userMatch=targetUsers.length&&targetUsers.includes(String(row.merchant_user_id));
  const roleMatch=targetRoles.length&&intersects(row.roles||[],targetRoles);
  const permissionMatch=targetPermissions.length&&(event.permission_mode==='ALL'?includesAll(row.permissions||[],targetPermissions):intersects(row.permissions||[],targetPermissions));
  return Boolean(userMatch||roleMatch||permissionMatch);
 });
}

async function claimEvents(db,config){
 await db.query(`UPDATE staff_push_outbox SET status='FAILED',processed_at=now(),last_error='PUSH_EVENT_EXPIRED',updated_at=now() WHERE status IN ('PENDING','PROCESSING') AND created_at<now()-interval '6 hours'`);
 return db.transaction(async client=>{
  const rows=await client.query(`WITH picked AS (
    SELECT id FROM staff_push_outbox
    WHERE ((status='PENDING' AND available_at<=now()) OR (status='PROCESSING' AND locked_at<now()-interval '5 minutes')) AND attempt_count<$1
    ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2
   ) UPDATE staff_push_outbox o SET status='PROCESSING',locked_at=now(),attempt_count=o.attempt_count+1,updated_at=now() FROM picked WHERE o.id=picked.id RETURNING o.*`,[config.maxAttempts,config.batchSize]);
  return rows.rows;
 });
}

async function logDelivery(db,event,subscription,status,result){
 await db.query(`INSERT INTO staff_push_delivery_log(event_id,subscription_id,tenant_id,merchant_user_id,delivery_status,provider_status,error_code) VALUES($1,$2,$3,$4,$5,$6,$7)`,[event.id,subscription?.id||null,event.tenant_id,subscription?.merchant_user_id||null,status,result?.status??null,result?.error??null]);
}

async function deliveredSubscriptionIds(db,eventId){
 const rows=await db.query(`SELECT DISTINCT subscription_id FROM staff_push_delivery_log WHERE event_id=$1 AND delivery_status='DELIVERED' AND subscription_id IS NOT NULL`,[eventId]);
 return new Set(rows.rows.map(row=>String(row.subscription_id)));
}

async function deliverEvent(app,event,config){
 let recipients;
 try{recipients=await resolvePushRecipients(app.db,event);}catch(error){return retryEvent(app.db,event,config,error?.message||'RECIPIENT_RESOLUTION_FAILED');}
 const alreadyDelivered=await deliveredSubscriptionIds(app.db,event.id);
 let transient=false,lastError=null;
 const payload={version:1,category:event.category,title:event.title,body:event.body,route:event.route,event_id:event.public_id,entity:event.entity_type&&event.entity_ref?{type:event.entity_type,ref:event.entity_ref}:null};
 for(const subscription of recipients){
  if(alreadyDelivered.has(String(subscription.id)))continue;
  const result=await sendWebPush(subscription,payload,config);
  if(result.kind==='DELIVERED'){
   await app.db.query(`UPDATE staff_push_subscriptions SET failure_count=0,last_success_at=now(),last_seen_at=now(),updated_at=now() WHERE id=$1`,[subscription.id]);
   await logDelivery(app.db,event,subscription,'DELIVERED',result);
  }else if(result.kind==='EXPIRED'){
   await app.db.query(`UPDATE staff_push_subscriptions SET status='EXPIRED',failure_count=failure_count+1,last_failure_at=now(),disabled_at=now(),updated_at=now() WHERE id=$1`,[subscription.id]);
   await logDelivery(app.db,event,subscription,'EXPIRED',result);
  }else if(result.kind==='TRANSIENT'){
   transient=true;lastError=result.error;
   await app.db.query(`UPDATE staff_push_subscriptions SET failure_count=failure_count+1,last_failure_at=now(),updated_at=now() WHERE id=$1`,[subscription.id]);
   await logDelivery(app.db,event,subscription,'FAILED',result);
  }else{
   lastError=result.error;
   await app.db.query(`UPDATE staff_push_subscriptions SET failure_count=failure_count+1,last_failure_at=now(),updated_at=now() WHERE id=$1`,[subscription.id]);
   await logDelivery(app.db,event,subscription,'FAILED',result);
  }
 }
 if(transient)return retryEvent(app.db,event,config,lastError||'PUSH_TRANSIENT_FAILURE');
 await app.db.query(`UPDATE staff_push_outbox SET status='SENT',processed_at=now(),locked_at=NULL,last_error=$2,updated_at=now() WHERE id=$1`,[event.id,lastError]);
}

async function retryEvent(db,event,config,error){
 if(event.attempt_count>=config.maxAttempts){await db.query(`UPDATE staff_push_outbox SET status='FAILED',processed_at=now(),locked_at=NULL,last_error=$2,updated_at=now() WHERE id=$1`,[event.id,String(error).slice(0,1000)]);return;}
 const delay=Math.min(300,5*Math.pow(2,Math.max(0,event.attempt_count-1)));
 await db.query(`UPDATE staff_push_outbox SET status='PENDING',available_at=now()+($2::text||' seconds')::interval,locked_at=NULL,last_error=$3,updated_at=now() WHERE id=$1`,[event.id,delay,String(error).slice(0,1000)]);
}

export async function processStaffPushOutbox(app,config=loadStaffPushConfig()){
 if(!config.enabled)return{processed:0};
 const events=await claimEvents(app.db,config);
 for(const event of events){try{await deliverEvent(app,event,config);}catch(error){await retryEvent(app.db,event,config,error?.message||'PUSH_DELIVERY_FAILED');}}
 return{processed:events.length};
}

export function startStaffPushWorker(app,config=loadStaffPushConfig()){
 if(!config.enabled)return()=>{};
 let stopped=false,running=false;
 const tick=async()=>{if(stopped||running)return;running=true;try{await processStaffPushOutbox(app,config);}catch(error){app.log.error({err:error},'Staff Web push outbox worker failed');}finally{running=false;}};
 const timer=setInterval(tick,config.workerIntervalMs);timer.unref?.();setImmediate(tick);
 return()=>{stopped=true;clearInterval(timer);};
}
