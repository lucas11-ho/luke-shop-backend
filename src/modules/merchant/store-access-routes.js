import { PERMISSIONS } from '../../core/permissions.js';
import { errors } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { loadEffectiveStoreScope, updateStaffStoreScope } from './store-access.js';

const staffRef={type:'string',minLength:6,maxLength:80};
async function targetStaff(db,tenantId,ref,{lock=false}={}){
 const row=await db.query(`SELECT id,public_id,email,display_name,status,store_access_mode FROM merchant_users WHERE tenant_id=$1 AND public_id=$2${lock?' FOR UPDATE':''}`,[tenantId,ref]);
 if(!row.rowCount)throw errors.notFound('MERCHANT_STAFF_NOT_FOUND','Merchant staff account not found');
 return row.rows[0];
}
async function roleKeys(db,tenantId,userId){const rows=await db.query(`SELECT r.key FROM merchant_user_roles ur JOIN merchant_roles r ON r.id=ur.role_id AND r.tenant_id=ur.tenant_id WHERE ur.tenant_id=$1 AND ur.merchant_user_id=$2 ORDER BY r.key`,[tenantId,userId]);return rows.rows.map(row=>row.key)}

export async function merchantStoreAccessRoutes(app){
 const staffRead=app.requirePermission(PERMISSIONS.MERCHANT_STAFF_READ);
 const staffManage=app.requirePermission(PERMISSIONS.MERCHANT_STAFF_MANAGE);

 app.get('/v1/merchant/staff/:staffRef/store-access',{preHandler:[app.requireMerchantAuth,staffRead],schema:{params:{type:'object',additionalProperties:false,required:['staffRef'],properties:{staffRef}}}},async request=>{
  const staff=await targetStaff(app.db,request.auth.tenantId,request.params.staffRef),roles=await roleKeys(app.db,request.auth.tenantId,staff.id);
  const scope=await loadEffectiveStoreScope(app.db,{tenantId:request.auth.tenantId,userId:staff.id,roleKeys:roles,storedMode:staff.store_access_mode});
  return {data:{staff:{id:staff.public_id,email:staff.email,display_name:staff.display_name,status:staff.status,roles,store_scope:scope}}};
 });

 app.put('/v1/merchant/staff/:staffRef/store-access',{
  preHandler:[app.requireMerchantAuth,staffManage],
  schema:{params:{type:'object',additionalProperties:false,required:['staffRef'],properties:{staffRef}},body:{type:'object',additionalProperties:false,required:['mode'],properties:{mode:{type:'string',enum:['ALL_STORES','ASSIGNED_STORES']},store_ids:{type:'array',uniqueItems:true,maxItems:100,items:{type:'string',minLength:6,maxLength:80}}}}},
 },async request=>{
  const result=await app.db.transaction(async client=>{
   const staff=await targetStaff(client,request.auth.tenantId,request.params.staffRef,{lock:true});
   const before=await loadEffectiveStoreScope(client,{tenantId:request.auth.tenantId,userId:staff.id,roleKeys:await roleKeys(client,request.auth.tenantId,staff.id),storedMode:staff.store_access_mode});
   const scope=await updateStaffStoreScope(client,{tenantId:request.auth.tenantId,userId:staff.id,actorId:request.auth.actorId,mode:request.body.mode,storePublicIds:request.body.store_ids||[]});
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'merchant.staff.store_access.update',targetType:'merchant_user',targetId:staff.id,metadata:{from_mode:before.mode,to_mode:scope.mode,from_store_ids:before.stores.map(store=>store.id),to_store_ids:scope.stores.map(store=>store.id)},requestIp:request.ip,requestId:request.id});
   return {id:staff.public_id,email:staff.email,display_name:staff.display_name,status:staff.status,store_scope:scope};
  });
  return {data:{staff:result}};
 });
}
