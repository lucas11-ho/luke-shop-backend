import { createHash } from 'node:crypto';
import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { assertFulfillmentTypeTransition } from './service.js';
import { money } from '../orders/service.js';
import { allowedMime, deleteAsset, extensionForMime, hasExpectedSignature, safeOriginalFilename, writeAsset } from '../assets/storage.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const driverImageTypes=new Set(['image/jpeg','image/png','image/webp']);
const DRIVER_NEXT={ASSIGNED:'ACCEPTED',ACCEPTED:'PICKED_UP',PICKED_UP:'OUT_FOR_DELIVERY',OUT_FOR_DELIVERY:'DELIVERED'};
const DRIVER_ACTIVE_LOCATION=new Set(['ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY']);
const DELIVERY_TYPES=new Set(['PHYSICAL_SHIPPING','PHYSICAL_LOCAL_DELIVERY','FOOD_DELIVERY']);
const cleanMime=value=>String(value||'').split(';')[0].trim().toLowerCase();

async function driverContext(app,request){
 const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request));
 const found=await app.db.query(`SELECT d.*,mu.public_id AS merchant_user_public_id,mu.email AS merchant_user_email
   FROM delivery_drivers d JOIN merchant_users mu ON mu.id=d.merchant_user_id AND mu.tenant_id=d.tenant_id
   WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.merchant_user_id=$3 AND d.status='ACTIVE'`,[request.auth.tenantId,store.id,request.auth.actorId]);
 if(!found.rowCount)throw errors.forbidden('DRIVER_PROFILE_REQUIRED','This merchant account is not linked to an active driver for the selected store');
 return {store,driver:found.rows[0]};
}

const dispatchJoin=`SELECT x.*,d.public_id AS driver_public_id,d.display_name AS driver_name,d.phone_e164 AS driver_phone,d.vehicle_type,d.vehicle_label,
 f.id AS fulfillment_internal_id,f.public_id AS fulfillment_public_id,f.fulfillment_type,f.fulfillment_mode,f.status AS fulfillment_status,
 o.id AS order_internal_id,o.public_id AS order_public_id,o.order_number,o.order_type,o.status AS order_status,o.payment_status,o.currency AS order_currency,o.grand_total,
 c.display_name AS customer_name,oa.recipient_name,oa.phone AS recipient_phone,oa.country_code,oa.state,oa.city,oa.postal_code,oa.address_line_1,oa.address_line_2,oa.delivery_note,oa.formatted_address,oa.latitude AS destination_latitude,oa.longitude AS destination_longitude,
 op.id AS payment_internal_id,op.public_id AS payment_public_id,op.status AS payment_record_status,op.amount AS payment_amount,op.currency AS payment_currency,
 pm.public_id AS payment_method_id,pm.code AS payment_method_code,pm.name AS payment_method_name,pm.provider_type
 FROM delivery_dispatches x
 JOIN delivery_drivers d ON d.id=x.driver_id AND d.tenant_id=x.tenant_id AND d.store_id=x.store_id
 JOIN order_fulfillments f ON f.id=x.fulfillment_id AND f.tenant_id=x.tenant_id AND f.store_id=x.store_id
 JOIN orders o ON o.id=f.order_id AND o.tenant_id=f.tenant_id AND o.store_id=f.store_id
 JOIN customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
 LEFT JOIN order_addresses oa ON oa.order_id=o.id AND oa.tenant_id=o.tenant_id AND oa.store_id=o.store_id
 LEFT JOIN order_payments op ON op.order_id=o.id AND op.tenant_id=o.tenant_id AND op.store_id=o.store_id
 LEFT JOIN payment_methods pm ON pm.id=op.payment_method_id AND pm.tenant_id=op.tenant_id AND pm.store_id=op.store_id`;

async function driverDispatch(db,{tenantId,storeId,driverId,ref,lock=false}){
 const row=await db.query(`${dispatchJoin} WHERE x.tenant_id=$1 AND x.store_id=$2 AND x.driver_id=$3 AND x.public_id=$4${lock?' FOR UPDATE OF x,f,o':''}`,[tenantId,storeId,driverId,ref]);
 if(!row.rowCount)throw errors.notFound('DRIVER_DISPATCH_NOT_FOUND','Assigned dispatch not found');
 return row.rows[0];
}

function publicDispatch(row){
 return {
  id:row.public_id,status:row.status,assigned_at:row.assigned_at,accepted_at:row.accepted_at,picked_up_at:row.picked_up_at,out_for_delivery_at:row.out_for_delivery_at,delivered_at:row.delivered_at,cancelled_at:row.cancelled_at,cancellation_reason:row.cancellation_reason,notes:row.notes,
  current_location:row.current_latitude==null||row.current_longitude==null?null:{latitude:row.current_latitude,longitude:row.current_longitude,accuracy_meters:row.current_accuracy_meters,updated_at:row.location_updated_at},
  driver:{id:row.driver_public_id,name:row.driver_name,phone:row.driver_phone,vehicle_type:row.vehicle_type,vehicle_label:row.vehicle_label},
  fulfillment:{id:row.fulfillment_public_id,type:row.fulfillment_type,mode:row.fulfillment_mode,status:row.fulfillment_status},
  order:{id:row.order_public_id,number:row.order_number,type:row.order_type,status:row.order_status,payment_status:row.payment_status,currency:row.order_currency,grand_total:money(row.grand_total)},
  customer:{name:row.customer_name,recipient_name:row.recipient_name,phone:row.recipient_phone},
  destination:row.address_line_1?{country_code:row.country_code,state:row.state,city:row.city,postal_code:row.postal_code,address_line_1:row.address_line_1,address_line_2:row.address_line_2,delivery_note:row.delivery_note,formatted_address:row.formatted_address,latitude:row.destination_latitude,longitude:row.destination_longitude}:null,
  payment:{id:row.payment_public_id,status:row.payment_record_status,amount:money(row.payment_amount),currency:row.payment_currency,method_id:row.payment_method_id,method_code:row.payment_method_code,method_name:row.payment_method_name,provider_type:row.provider_type,cod_required:row.provider_type==='CASH_ON_DELIVERY'},
  next_status:DRIVER_NEXT[row.status]||null,
 };
}

async function detailForDriver(app,context,dispatchRef){
 const row=await driverDispatch(app.db,{tenantId:context.driver.tenant_id,storeId:context.store.id,driverId:context.driver.id,ref:dispatchRef});
 const [events,proofs,cod]=await Promise.all([
  app.db.query(`SELECT event_type,actor_type,from_status,to_status,reason,metadata,created_at FROM delivery_dispatch_events WHERE tenant_id=$1 AND store_id=$2 AND dispatch_id=$3 ORDER BY created_at,id`,[context.driver.tenant_id,context.store.id,row.id]),
  app.db.query(`SELECT p.public_id AS id,p.proof_type,p.recipient_name,p.note,p.created_at,a.public_id AS asset_id,a.original_filename,a.mime_type,a.file_size FROM delivery_proofs p LEFT JOIN media_assets a ON a.id=p.asset_id AND a.tenant_id=p.tenant_id AND a.store_id=p.store_id WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.dispatch_id=$3 ORDER BY p.created_at,p.id`,[context.driver.tenant_id,context.store.id,row.id]),
  app.db.query(`SELECT public_id AS id,status,currency,expected_amount,collected_amount,collection_note,remittance_note,reconciliation_note,collected_at,remitted_at,reconciled_at FROM delivery_cod_collections WHERE tenant_id=$1 AND store_id=$2 AND dispatch_id=$3 LIMIT 1`,[context.driver.tenant_id,context.store.id,row.id]),
 ]);
 return {...publicDispatch(row),events:events.rows,proofs:proofs.rows,cod_collection:cod.rows[0]||null};
}

async function synchronizeFulfillment(client,row,targetStatus,driver,request){
 let next=null;
 if(targetStatus==='PICKED_UP'){
  if(row.fulfillment_type==='PHYSICAL_SHIPPING'){
   if(row.fulfillment_status==='READY')next='SHIPPED';
   else if(!['SHIPPED','OUT_FOR_DELIVERY','DELIVERED'].includes(row.fulfillment_status))throw errors.conflict('DRIVER_FULFILLMENT_NOT_READY','Shipping fulfillment must be ready before pickup');
  }else if(['PHYSICAL_LOCAL_DELIVERY','FOOD_DELIVERY'].includes(row.fulfillment_type)){
   if(!['READY','OUT_FOR_DELIVERY','DELIVERED'].includes(row.fulfillment_status))throw errors.conflict('DRIVER_FULFILLMENT_NOT_READY','Delivery fulfillment must be ready before pickup');
  }
 }
 if(targetStatus==='OUT_FOR_DELIVERY'){
  if(row.fulfillment_type==='PHYSICAL_SHIPPING'){
   if(row.fulfillment_status==='SHIPPED')next='OUT_FOR_DELIVERY';
   else if(!['OUT_FOR_DELIVERY','DELIVERED'].includes(row.fulfillment_status))throw errors.conflict('DRIVER_FULFILLMENT_NOT_READY','Shipping fulfillment must be shipped before going out for delivery');
  }else if(['PHYSICAL_LOCAL_DELIVERY','FOOD_DELIVERY'].includes(row.fulfillment_type)){
   if(row.fulfillment_status==='READY')next='OUT_FOR_DELIVERY';
   else if(!['OUT_FOR_DELIVERY','DELIVERED'].includes(row.fulfillment_status))throw errors.conflict('DRIVER_FULFILLMENT_NOT_READY','Delivery fulfillment must be ready before going out for delivery');
  }
 }
 if(targetStatus==='DELIVERED'){
  if(row.fulfillment_status==='OUT_FOR_DELIVERY')next='DELIVERED';
  else if(row.fulfillment_status!=='DELIVERED')throw errors.conflict('DRIVER_FULFILLMENT_NOT_OUT_FOR_DELIVERY','Fulfillment must be out for delivery before it can be delivered');
 }
 if(!next)return;
 assertFulfillmentTypeTransition(row.fulfillment_type,row.fulfillment_status,next);
 await client.query(`UPDATE order_fulfillments SET status=$1,shipped_at=CASE WHEN $1='SHIPPED' THEN COALESCE(shipped_at,now()) ELSE shipped_at END,delivered_at=CASE WHEN $1='DELIVERED' THEN COALESCE(delivered_at,now()) ELSE delivered_at END,updated_at=now() WHERE id=$2`,[next,row.fulfillment_internal_id]);
 await client.query(`INSERT INTO fulfillment_status_history(tenant_id,store_id,fulfillment_id,from_status,to_status,reason,actor_type,actor_id,request_id) VALUES($1,$2,$3,$4,$5,'Driver mobile milestone','DRIVER',$6,$7)`,[row.tenant_id,row.store_id,row.fulfillment_internal_id,row.fulfillment_status,next,driver.id,request.id]);
 row.fulfillment_status=next;
}

export async function driverDeliveryRoutes(app){
 for(const mime of driverImageTypes)if(!app.hasContentTypeParser(mime))app.addContentTypeParser(mime,{parseAs:'buffer',bodyLimit:app.config.assetImageMaxBytes},(_request,body,done)=>done(null,body));
 const auth=[app.requireMerchantAuth];

 app.get('/v1/driver/me',{preHandler:auth},async request=>{
  const context=await driverContext(app,request);
  const counts=await app.db.query(`SELECT count(*) FILTER (WHERE status NOT IN ('DELIVERED','CANCELLED'))::int AS active_dispatches,count(*) FILTER (WHERE status='OUT_FOR_DELIVERY')::int AS out_for_delivery FROM delivery_dispatches WHERE tenant_id=$1 AND store_id=$2 AND driver_id=$3`,[request.auth.tenantId,context.store.id,context.driver.id]);
  return {data:{driver:{id:context.driver.public_id,display_name:context.driver.display_name,phone_e164:context.driver.phone_e164,vehicle_type:context.driver.vehicle_type,vehicle_label:context.driver.vehicle_label,merchant_user_id:context.driver.merchant_user_public_id,merchant_user_email:context.driver.merchant_user_email,store:{id:context.store.public_id,name:context.store.name},...counts.rows[0]}}};
 });

 app.get('/v1/driver/dispatches',{preHandler:auth,schema:{querystring:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED','CANCELLED']},limit:{type:'integer',minimum:1,maximum:100,default:50}}}}},async request=>{
  const context=await driverContext(app,request),values=[request.auth.tenantId,context.store.id,context.driver.id];let filter='x.tenant_id=$1 AND x.store_id=$2 AND x.driver_id=$3';
  if(request.query.status){values.push(request.query.status);filter+=` AND x.status=$${values.length}`;}values.push(request.query.limit||50);
  const rows=await app.db.query(`${dispatchJoin} WHERE ${filter} ORDER BY CASE WHEN x.status IN ('DELIVERED','CANCELLED') THEN 1 ELSE 0 END,x.assigned_at DESC LIMIT $${values.length}`,values);
  return {data:{dispatches:rows.rows.map(publicDispatch)}};
 });

 app.get('/v1/driver/dispatches/:dispatchId',{preHandler:auth},async request=>{
  const context=await driverContext(app,request);return {data:{dispatch:await detailForDriver(app,context,request.params.dispatchId)}};
 });

 app.post('/v1/driver/dispatches/:dispatchId/status',{preHandler:auth,schema:{body:{type:'object',additionalProperties:false,required:['status'],properties:{status:{type:'string',enum:['ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED']},note:{type:'string',maxLength:1000}}}}},async request=>{
  const context=await driverContext(app,request);
  await app.db.transaction(async client=>{
   const row=await driverDispatch(client,{tenantId:request.auth.tenantId,storeId:context.store.id,driverId:context.driver.id,ref:request.params.dispatchId,lock:true});
   if(!DELIVERY_TYPES.has(row.fulfillment_type))throw errors.conflict('DRIVER_DISPATCH_TYPE_UNSUPPORTED','This fulfillment cannot be progressed from Driver mode');
   const expected=DRIVER_NEXT[row.status];if(!expected)throw errors.conflict('DRIVER_DISPATCH_TERMINAL','This dispatch has no further driver milestone');
   if(request.body.status!==expected)throw errors.conflict('DRIVER_DISPATCH_TRANSITION_INVALID',`Driver dispatch must transition from ${row.status} to ${expected}`);
   if(expected==='DELIVERED'){
    const proof=await client.query(`SELECT 1 FROM delivery_proofs WHERE tenant_id=$1 AND store_id=$2 AND dispatch_id=$3 LIMIT 1`,[request.auth.tenantId,context.store.id,row.id]);if(!proof.rowCount)throw errors.conflict('DELIVERY_PROOF_REQUIRED','Add delivery proof before marking this dispatch delivered');
    if(row.provider_type==='CASH_ON_DELIVERY'){
     const collection=await client.query(`SELECT status FROM delivery_cod_collections WHERE tenant_id=$1 AND store_id=$2 AND dispatch_id=$3 LIMIT 1`,[request.auth.tenantId,context.store.id,row.id]);if(!collection.rowCount)throw errors.conflict('COD_COLLECTION_REQUIRED','Record the cash-on-delivery collection before marking this dispatch delivered');
    }
   }
   await synchronizeFulfillment(client,row,expected,context.driver,request);
   const timestampColumn={ACCEPTED:'accepted_at',PICKED_UP:'picked_up_at',OUT_FOR_DELIVERY:'out_for_delivery_at',DELIVERED:'delivered_at'}[expected];
   await client.query(`UPDATE delivery_dispatches SET status=$1,${timestampColumn}=COALESCE(${timestampColumn},now()),notes=CASE WHEN $2::text IS NULL THEN notes ELSE $2 END,updated_at=now() WHERE id=$3`,[expected,request.body.note?.trim()||null,row.id]);
   await client.query(`INSERT INTO delivery_dispatch_events(tenant_id,store_id,dispatch_id,event_type,actor_type,actor_id,from_status,to_status,reason,request_id) VALUES($1,$2,$3,'STATUS_CHANGED','DRIVER',$4,$5,$6,$7,$8)`,[request.auth.tenantId,context.store.id,row.id,context.driver.id,row.status,expected,request.body.note?.trim()||null,request.id]);
   if(expected==='DELIVERED')await client.query(`UPDATE customer_live_location_sessions SET status='STOPPED',stopped_at=COALESCE(stopped_at,now()),stop_reason='FULFILLMENT_TERMINAL',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status='ACTIVE'`,[request.auth.tenantId,context.store.id,row.order_internal_id]);
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'DRIVER',actorId:context.driver.id,action:'delivery.driver.status',targetType:'delivery_dispatch',targetId:row.id,metadata:{merchant_user_id:request.auth.profile.public_id,from_status:row.status,to_status:expected,fulfillment_id:row.fulfillment_public_id,order_number:row.order_number},requestIp:request.ip,requestId:request.id});
  });
  return {data:{dispatch:await detailForDriver(app,context,request.params.dispatchId)}};
 });

 app.post('/v1/driver/dispatches/:dispatchId/location',{preHandler:auth,schema:{body:{type:'object',additionalProperties:false,required:['latitude','longitude'],properties:{latitude:{type:'number',minimum:-90,maximum:90},longitude:{type:'number',minimum:-180,maximum:180},accuracy_meters:{type:['number','null'],minimum:0,maximum:100000}}}}},async request=>{
  const context=await driverContext(app,request);let sampled=false;
  await app.db.transaction(async client=>{
   const row=await driverDispatch(client,{tenantId:request.auth.tenantId,storeId:context.store.id,driverId:context.driver.id,ref:request.params.dispatchId,lock:true});
   if(!DRIVER_ACTIVE_LOCATION.has(row.status))throw errors.conflict('DRIVER_LOCATION_NOT_ACTIVE','Driver location can be updated only after acceptance and before delivery');
   await client.query(`UPDATE delivery_dispatches SET current_latitude=$1,current_longitude=$2,current_accuracy_meters=$3,location_updated_at=now(),updated_at=now() WHERE id=$4`,[request.body.latitude,request.body.longitude,request.body.accuracy_meters??null,row.id]);
   const latest=await client.query(`SELECT created_at FROM delivery_driver_location_events WHERE tenant_id=$1 AND store_id=$2 AND dispatch_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,[request.auth.tenantId,context.store.id,row.id]);
   if(!latest.rowCount||Date.now()-new Date(latest.rows[0].created_at).getTime()>=30000){await client.query(`INSERT INTO delivery_driver_location_events(tenant_id,store_id,dispatch_id,driver_id,latitude,longitude,accuracy_meters,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[request.auth.tenantId,context.store.id,row.id,context.driver.id,request.body.latitude,request.body.longitude,request.body.accuracy_meters??null,request.id]);sampled=true;}
  });
  return {data:{location:{latitude:request.body.latitude,longitude:request.body.longitude,accuracy_meters:request.body.accuracy_meters??null,sampled}}};
 });

 app.post('/v1/driver/dispatches/:dispatchId/proofs',{preHandler:auth,schema:{body:{type:'object',additionalProperties:false,properties:{recipient_name:{type:'string',maxLength:160},note:{type:'string',maxLength:1000}},anyOf:[{required:['recipient_name']},{required:['note']}]}}},async(request,reply)=>{
  const context=await driverContext(app,request);let proof;
  await app.db.transaction(async client=>{
   const row=await driverDispatch(client,{tenantId:request.auth.tenantId,storeId:context.store.id,driverId:context.driver.id,ref:request.params.dispatchId,lock:true});if(['DELIVERED','CANCELLED'].includes(row.status))throw errors.conflict('DELIVERY_PROOF_WINDOW_CLOSED','Proof cannot be added to a terminal dispatch');
   const id=uuid(),pid=publicId('dpf');proof=(await client.query(`INSERT INTO delivery_proofs(id,public_id,tenant_id,store_id,dispatch_id,driver_id,proof_type,recipient_name,note,created_by,request_id) VALUES($1,$2,$3,$4,$5,$6,'ACKNOWLEDGEMENT',$7,$8,$9,$10) RETURNING public_id AS id,proof_type,recipient_name,note,created_at`,[id,pid,request.auth.tenantId,context.store.id,row.id,context.driver.id,request.body.recipient_name?.trim()||null,request.body.note?.trim()||null,request.auth.actorId,request.id])).rows[0];
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'DRIVER',actorId:context.driver.id,action:'delivery.proof.add',targetType:'delivery_dispatch',targetId:row.id,metadata:{proof_id:pid,proof_type:'ACKNOWLEDGEMENT',merchant_user_id:request.auth.profile.public_id},requestIp:request.ip,requestId:request.id});
  });return reply.code(201).send({data:{proof}});
 });

 app.post('/v1/driver/dispatches/:dispatchId/proof-photo',{bodyLimit:app.config.assetImageMaxBytes,preHandler:auth,schema:{querystring:{type:'object',additionalProperties:false,required:['filename'],properties:{filename:{type:'string',minLength:1,maxLength:240}}}}},async(request,reply)=>{
  const context=await driverContext(app,request),mime=cleanMime(request.headers['content-type']);if(!driverImageTypes.has(mime)||!allowedMime(mime))throw errors.badRequest('DELIVERY_PROOF_MEDIA_TYPE_UNSUPPORTED','Use JPEG, PNG, or WEBP for delivery proof');
  if(!Buffer.isBuffer(request.body)||!request.body.length)throw errors.badRequest('DELIVERY_PROOF_FILE_REQUIRED','Proof photo body is empty');if(request.body.length>app.config.assetImageMaxBytes)throw errors.badRequest('DELIVERY_PROOF_FILE_TOO_LARGE','Proof photo exceeds the configured image upload limit');if(!hasExpectedSignature(request.body,mime))throw errors.badRequest('DELIVERY_PROOF_SIGNATURE_INVALID','Uploaded proof bytes do not match the declared image type');
  const row=await driverDispatch(app.db,{tenantId:request.auth.tenantId,storeId:context.store.id,driverId:context.driver.id,ref:request.params.dispatchId});if(['DELIVERED','CANCELLED'].includes(row.status))throw errors.conflict('DELIVERY_PROOF_WINDOW_CLOSED','Proof cannot be added to a terminal dispatch');
  const assetInternalId=uuid(),assetPublicId=publicId('ast'),proofId=uuid(),proofPublicId=publicId('dpf'),ext=extensionForMime(mime),storageKey=`${request.auth.tenantId}/${context.store.id}/delivery-proofs/${assetPublicId}${ext}`,digest=createHash('sha256').update(request.body).digest('hex');
  await writeAsset(app.config,storageKey,request.body,mime);let proof;
  try{await app.db.transaction(async client=>{
   const locked=await driverDispatch(client,{tenantId:request.auth.tenantId,storeId:context.store.id,driverId:context.driver.id,ref:request.params.dispatchId,lock:true});if(['DELIVERED','CANCELLED'].includes(locked.status))throw errors.conflict('DELIVERY_PROOF_WINDOW_CLOSED','Proof cannot be added to a terminal dispatch');
   await client.query(`INSERT INTO media_assets(id,public_id,tenant_id,store_id,storage_provider,storage_key,visibility,media_type,mime_type,original_filename,file_size,sha256,url,uploaded_by,metadata) VALUES($1,$2,$3,$4,$5,$6,'PRIVATE','IMAGE',$7,$8,$9,$10,NULL,$11,$12::jsonb)`,[assetInternalId,assetPublicId,request.auth.tenantId,context.store.id,app.config.assetStorageDriver,storageKey,mime,safeOriginalFilename(request.query.filename),request.body.length,digest,request.auth.actorId,JSON.stringify({purpose:'DELIVERY_PROOF',dispatch_id:locked.public_id})]);
   proof=(await client.query(`INSERT INTO delivery_proofs(id,public_id,tenant_id,store_id,dispatch_id,driver_id,proof_type,asset_id,created_by,request_id) VALUES($1,$2,$3,$4,$5,$6,'PHOTO',$7,$8,$9) RETURNING public_id AS id,proof_type,created_at`,[proofId,proofPublicId,request.auth.tenantId,context.store.id,locked.id,context.driver.id,assetInternalId,request.auth.actorId,request.id])).rows[0];
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'DRIVER',actorId:context.driver.id,action:'delivery.proof.photo',targetType:'delivery_dispatch',targetId:locked.id,metadata:{proof_id:proofPublicId,asset_id:assetPublicId,mime_type:mime,file_size:request.body.length,merchant_user_id:request.auth.profile.public_id},requestIp:request.ip,requestId:request.id});
  });}catch(error){try{await deleteAsset(app.config,storageKey);}catch(cleanupError){app.log.error({err:cleanupError,request_id:request.id,storage_key:storageKey},'delivery proof rollback cleanup failed');}throw error;}
  return reply.code(201).send({data:{proof:{...proof,asset_id:assetPublicId,original_filename:safeOriginalFilename(request.query.filename),mime_type:mime,file_size:request.body.length}}});
 });

 app.post('/v1/driver/dispatches/:dispatchId/cod/collect',{preHandler:auth,schema:{body:{type:'object',additionalProperties:false,required:['amount'],properties:{amount:{type:'number',minimum:0},note:{type:'string',maxLength:1000}}}}},async(request,reply)=>{
  const context=await driverContext(app,request);let collection;
  await app.db.transaction(async client=>{
   const row=await driverDispatch(client,{tenantId:request.auth.tenantId,storeId:context.store.id,driverId:context.driver.id,ref:request.params.dispatchId,lock:true});if(row.provider_type!=='CASH_ON_DELIVERY')throw errors.conflict('COD_NOT_REQUIRED','This dispatch is not paid by cash on delivery');if(row.status!=='OUT_FOR_DELIVERY')throw errors.conflict('COD_COLLECTION_WINDOW_INVALID','Cash on delivery can be recorded only while the dispatch is out for delivery');if(row.payment_record_status==='PAID')throw errors.conflict('COD_PAYMENT_ALREADY_SETTLED','This order payment is already settled');
   const expected=money(row.payment_amount),received=money(request.body.amount);if(received!==expected)throw errors.conflict('COD_AMOUNT_MISMATCH','Collected cash must equal the server-authoritative order payment amount',{expected_amount:expected,currency:row.payment_currency});
   const existing=await client.query(`SELECT public_id AS id,status,currency,expected_amount,collected_amount,collection_note,collected_at,remitted_at,reconciled_at FROM delivery_cod_collections WHERE tenant_id=$1 AND store_id=$2 AND dispatch_id=$3`,[request.auth.tenantId,context.store.id,row.id]);if(existing.rowCount){collection=existing.rows[0];return;}
   const id=uuid(),pid=publicId('cod');collection=(await client.query(`INSERT INTO delivery_cod_collections(id,public_id,tenant_id,store_id,dispatch_id,order_id,payment_id,driver_id,status,currency,expected_amount,collected_amount,collection_note,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'COLLECTED',$9,$10,$11,$12,$13) RETURNING public_id AS id,status,currency,expected_amount,collected_amount,collection_note,collected_at,remitted_at,reconciled_at`,[id,pid,request.auth.tenantId,context.store.id,row.id,row.order_internal_id,row.payment_internal_id,context.driver.id,row.payment_currency,expected,received,request.body.note?.trim()||null,request.id])).rows[0];
   await client.query(`INSERT INTO delivery_cod_events(tenant_id,store_id,collection_id,event_type,actor_type,actor_id,amount,note,request_id) VALUES($1,$2,$3,'COLLECTED','DRIVER',$4,$5,$6,$7)`,[request.auth.tenantId,context.store.id,id,context.driver.id,received,request.body.note?.trim()||null,request.id]);
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'DRIVER',actorId:context.driver.id,action:'delivery.cod.collect',targetType:'delivery_cod_collection',targetId:id,metadata:{merchant_user_id:request.auth.profile.public_id,dispatch_id:row.public_id,order_number:row.order_number,amount:received,currency:row.payment_currency},requestIp:request.ip,requestId:request.id});
  });return reply.code(201).send({data:{collection}});
 });
}
