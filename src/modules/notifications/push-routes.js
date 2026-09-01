import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { loadStaffPushConfig } from './push-config.js';
import {
 listStaffPushDevices,readStaffPushPreferences,readStaffPushStoreSettings,registerStaffPushSubscription,
 removeStaffPushDevice,saveStaffPushPreferences,saveStaffPushStoreSettings,
} from './push-service.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const CATEGORIES=['DRIVER_ASSIGNMENT','DRIVER_REASSIGNMENT','DISPATCH_CANCELLED','KITCHEN_NEW_ORDER','KITCHEN_READY','CASHIER_ACTION','COD_RECONCILIATION','DISPATCH_MESSAGE'];
const categorySchema={type:'object',additionalProperties:false,properties:Object.fromEntries(CATEGORIES.map(key=>[key,{type:'boolean'}]))};
const requireEnabled=config=>{if(!config.enabled)throw errors.conflict('STAFF_PUSH_DISABLED','Staff Web push notifications are not enabled on this Backend');};

export async function staffPushRoutes(app){
 const selfAuth=[app.requireMerchantAuth];
 const settingsRead=[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.STAFF_NOTIFICATIONS_READ)];
 const settingsManage=[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.STAFF_NOTIFICATIONS_MANAGE)];

 app.get('/v1/merchant/staff-push/public-key',{preHandler:selfAuth},async()=>{
  const config=loadStaffPushConfig();return{data:{enabled:config.enabled,public_key:config.enabled?config.publicKey:null,categories:CATEGORIES}};
 });

 app.get('/v1/merchant/staff-push/devices',{preHandler:selfAuth},async request=>({data:{devices:await listStaffPushDevices(app.db,{tenantId:request.auth.tenantId,merchantUserId:request.auth.actorId})}}));

 app.post('/v1/merchant/staff-push/subscriptions',{preHandler:selfAuth,schema:{body:{type:'object',additionalProperties:false,required:['subscription'],properties:{device_label:{type:['string','null'],maxLength:120},subscription:{type:'object',additionalProperties:false,required:['endpoint','keys'],properties:{endpoint:{type:'string',minLength:16,maxLength:4096},keys:{type:'object',additionalProperties:false,required:['p256dh','auth'],properties:{p256dh:{type:'string',minLength:40,maxLength:512},auth:{type:'string',minLength:8,maxLength:256}}}}}}}},async(request,reply)=>{
  const config=loadStaffPushConfig();requireEnabled(config);let device;
  try{device=await registerStaffPushSubscription(app.db,{tenantId:request.auth.tenantId,merchantUserId:request.auth.actorId,subscription:request.body.subscription,deviceLabel:request.body.device_label,userAgent:request.headers['user-agent']||null,config});}
  catch(error){throw errors.badRequest('STAFF_PUSH_SUBSCRIPTION_INVALID',error.message);}
  await app.db.transaction(async client=>writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'staff.push.device.register',targetType:'merchant_user',targetId:request.auth.actorId,metadata:{device_id:device.id,device_label:device.device_label},requestIp:request.ip,requestId:request.id}));
  return reply.code(201).send({data:{device}});
 });

 app.delete('/v1/merchant/staff-push/devices/:deviceId',{preHandler:selfAuth},async(request,reply)=>{
  const removed=await removeStaffPushDevice(app.db,{tenantId:request.auth.tenantId,merchantUserId:request.auth.actorId,deviceRef:request.params.deviceId});if(!removed)throw errors.notFound('STAFF_PUSH_DEVICE_NOT_FOUND','Push device not found');
  await app.db.transaction(async client=>writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'staff.push.device.remove',targetType:'merchant_user',targetId:request.auth.actorId,metadata:{device_id:request.params.deviceId},requestIp:request.ip,requestId:request.id}));
  return reply.code(200).send({data:{removed:true}});
 });

 app.get('/v1/merchant/staff-push/preferences',{preHandler:selfAuth},async request=>({data:{preferences:await readStaffPushPreferences(app.db,{tenantId:request.auth.tenantId,merchantUserId:request.auth.actorId})}}));
 app.put('/v1/merchant/staff-push/preferences',{preHandler:selfAuth,schema:{body:{type:'object',additionalProperties:false,properties:{enabled:{type:'boolean'},categories:categorySchema}}},async request=>{
  const current=await readStaffPushPreferences(app.db,{tenantId:request.auth.tenantId,merchantUserId:request.auth.actorId}),preferences=await saveStaffPushPreferences(app.db,{tenantId:request.auth.tenantId,merchantUserId:request.auth.actorId,enabled:request.body.enabled??current.enabled,categories:request.body.categories??current.categories});
  return{data:{preferences}};
 });

 app.get('/v1/merchant/staff-push/settings',{preHandler:settingsRead},async request=>{
  const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});return{data:{settings:await readStaffPushStoreSettings(app.db,{tenantId:request.auth.tenantId,storeId:store.id}),categories:CATEGORIES}};
 });
 app.put('/v1/merchant/staff-push/settings',{preHandler:settingsManage,schema:{body:{type:'object',additionalProperties:false,properties:{enabled:{type:'boolean'},categories:categorySchema}}},async request=>{
  const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false}),current=await readStaffPushStoreSettings(app.db,{tenantId:request.auth.tenantId,storeId:store.id});
  const settings=await app.db.transaction(async client=>{const saved=await saveStaffPushStoreSettings(client,{tenantId:request.auth.tenantId,storeId:store.id,enabled:request.body.enabled??current.enabled,categories:request.body.categories??current.categories,actorId:request.auth.actorId});await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'staff.push.settings.update',targetType:'store',targetId:store.id,metadata:{enabled:saved.enabled,categories:saved.categories},requestIp:request.ip,requestId:request.id});return saved;});
  return{data:{settings,categories:CATEGORIES}};
 });

 app.get('/v1/merchant/staff-push/admin/devices',{preHandler:settingsRead},async request=>{
  const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
  const rows=await app.db.query(`SELECT mu.public_id AS staff_id,mu.display_name,mu.email,mu.status,mu.store_access_mode,
    count(s.id)::int AS device_count,count(s.id) FILTER(WHERE s.status='ACTIVE')::int AS active_devices,max(s.last_seen_at) AS last_seen_at,max(s.last_success_at) AS last_push_success_at
   FROM merchant_users mu LEFT JOIN staff_push_subscriptions s ON s.tenant_id=mu.tenant_id AND s.merchant_user_id=mu.id
   WHERE mu.tenant_id=$1 AND (mu.store_access_mode='ALL_STORES' OR EXISTS(SELECT 1 FROM merchant_user_store_access usa WHERE usa.tenant_id=mu.tenant_id AND usa.merchant_user_id=mu.id AND usa.store_id=$2))
   GROUP BY mu.id,mu.public_id,mu.display_name,mu.email,mu.status,mu.store_access_mode ORDER BY mu.display_name,mu.email`,[request.auth.tenantId,store.id]);
  return{data:{staff:rows.rows}};
 });
}
