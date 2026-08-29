import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { adjustVipReward, expireDueVipEntitlements, expireDueVipRewards, vipExecutionSummary, vipRewardAccount } from './execution.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const readGuard=app=>[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.LOYALTY_READ)];
const manageGuard=app=>[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.LOYALTY_MANAGE)];
async function merchantStore(app,request){return resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});}
async function customerByRef(db,tenantId,ref){const result=await db.query(`SELECT id,public_id,customer_code,display_name FROM customers WHERE tenant_id=$1 AND (public_id=$2 OR customer_code=$2)`,[tenantId,ref]);if(!result.rowCount)throw errors.notFound('CUSTOMER_NOT_FOUND','Customer not found');return result.rows[0];}

export async function loyaltyExecutionRoutes(app){
  app.get('/v1/merchant/vip/execution',{preHandler:readGuard(app)},async request=>{
    const store=await merchantStore(app,request);const summary=await app.db.transaction(client=>vipExecutionSummary(client,{tenantId:request.auth.tenantId,storeId:store.id}));
    return {data:{store:{id:store.public_id,name:store.name},execution:summary}};
  });

  app.put('/v1/merchant/vip/execution-policy',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['upgrade_policy'],properties:{upgrade_policy:{type:'string',enum:['IMMEDIATE','SCHEDULED','MANUAL']}}}}},async request=>{
    const store=await merchantStore(app,request);let policy;
    await app.db.transaction(async client=>{
      const result=await client.query(`UPDATE vip_programs SET upgrade_policy=$1,updated_at=now() WHERE tenant_id=$2 AND store_id=$3 RETURNING enabled,upgrade_policy`,[request.body.upgrade_policy,request.auth.tenantId,store.id]);
      if(!result.rowCount)throw errors.notFound('VIP_PROGRAM_NOT_FOUND','VIP program not found');policy=result.rows[0];
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.execution_policy.update',targetType:'vip_program',targetId:store.id,metadata:{upgrade_policy:request.body.upgrade_policy},requestIp:request.ip,requestId:request.id});
    });
    return {data:{policy}};
  });

  app.get('/v1/merchant/vip/members/:customerRef/rewards',{preHandler:readGuard(app)},async request=>{
    const store=await merchantStore(app,request),customer=await customerByRef(app.db,request.auth.tenantId,request.params.customerRef);
    const rewards=await app.db.transaction(client=>vipRewardAccount(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:customer.id}));
    return {data:{customer:{id:customer.public_id,customer_code:customer.customer_code,display_name:customer.display_name},rewards}};
  });

  app.post('/v1/merchant/vip/members/:customerRef/rewards/adjust',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['amount','reason'],properties:{amount:{type:'number',minimum:-1000000,maximum:1000000},reason:{type:'string',minLength:3,maxLength:1000},expires_at:{type:['string','null'],format:'date-time'}}}}},async request=>{
    const store=await merchantStore(app,request),customer=await customerByRef(app.db,request.auth.tenantId,request.params.customerRef);let rewards;
    await app.db.transaction(async client=>{
      rewards=await adjustVipReward(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:customer.id,amount:request.body.amount,reason:request.body.reason.trim(),expiresAt:request.body.expires_at?new Date(request.body.expires_at):null,actorId:request.auth.actorId});
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.reward.adjust',targetType:'customer',targetId:customer.id,metadata:{amount:Number(request.body.amount),reason:request.body.reason.trim(),expires_at:request.body.expires_at||null},requestIp:request.ip,requestId:request.id});
    });
    return {data:{customer:{id:customer.public_id,customer_code:customer.customer_code,display_name:customer.display_name},rewards}};
  });

  app.post('/v1/merchant/vip/rewards/expire',{preHandler:manageGuard(app)},async request=>{
    const store=await merchantStore(app,request);let rewards=0,entitlements=0;
    await app.db.transaction(async client=>{rewards=await expireDueVipRewards(client,{tenantId:request.auth.tenantId,storeId:store.id});entitlements=await expireDueVipEntitlements(client,{tenantId:request.auth.tenantId,storeId:store.id});});
    return {data:{expired_rewards:rewards,expired_entitlements:entitlements}};
  });

  app.get('/v1/customer/vip/rewards',{preHandler:[app.requireCustomerAuth]},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request));
    const rewards=await app.db.transaction(client=>vipRewardAccount(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:request.auth.actorId,ledgerLimit:50}));
    return {data:{rewards}};
  });
}
