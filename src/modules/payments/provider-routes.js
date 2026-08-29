import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { loadProviderCredentials, providerCredentialStatus, saveProviderCredentials, tokenPayCredentialView } from './provider-credentials.js';
import { TOKENPAY_PROVIDER_KEY } from './providers/tokenpay.js';

const storeHeader=request=>request.headers['x-store-id']||null;
async function tokenPayMethod(app,request,store){
  const found=await app.db.query(`SELECT * FROM payment_methods WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 LIMIT 1`,[request.auth.tenantId,store.id,request.params.methodId]);
  if(!found.rowCount) throw errors.notFound('PAYMENT_METHOD_NOT_FOUND','Payment method not found');
  const method=found.rows[0];
  if(method.provider_type!=='EXTERNAL'||String(method.provider_key||'').toUpperCase()!==TOKENPAY_PROVIDER_KEY){
    throw errors.conflict('PAYMENT_PROVIDER_MISMATCH','Payment method is not configured as TokenPay');
  }
  return method;
}

export async function merchantPaymentProviderRoutes(app){
  app.get('/v1/merchant/payment-methods/:methodId/provider-config',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.PAYMENTS_READ)]},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const method=await tokenPayMethod(app,request,store);
    const status=await providerCredentialStatus(app.db,{tenantId:request.auth.tenantId,storeId:store.id,paymentMethodId:method.id});
    let credentials={app_id:'',mch_id:'',app_secret_configured:false};
    if(status.configured){
      credentials=tokenPayCredentialView(await loadProviderCredentials(app,app.db,{tenantId:request.auth.tenantId,storeId:store.id,paymentMethodId:method.id,providerKey:TOKENPAY_PROVIDER_KEY}));
    }
    return {data:{provider:{key:TOKENPAY_PROVIDER_KEY,credentials,credential_status:status,settings:{
      chain:String(method.public_config?.chain||''),currency:String(method.public_config?.currency||''),expire_second:Number(method.public_config?.expire_second||600),locale:method.public_config?.locale==='zh_cn'?'zh_cn':'en',to_address:String(method.public_config?.to_address||''),
    }}}};
  });

  app.put('/v1/merchant/payment-methods/:methodId/provider-config',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.PAYMENTS_MANAGE)],schema:{body:{type:'object',additionalProperties:false,required:['app_id','mch_id','chain','currency'],properties:{
    app_id:{type:'string',minLength:4,maxLength:120},mch_id:{type:'string',minLength:1,maxLength:120},app_secret:{type:'string',minLength:1,maxLength:160},
    chain:{type:'string',pattern:'^[A-Za-z0-9_-]{2,30}$'},currency:{type:'string',pattern:'^[A-Za-z0-9]{2,12}$'},expire_second:{type:'integer',minimum:60,maximum:86400},locale:{type:'string',enum:['en','zh_cn']},to_address:{type:['string','null'],maxLength:240}
  }}}},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const method=await tokenPayMethod(app,request,store);
    const status=await providerCredentialStatus(app.db,{tenantId:request.auth.tenantId,storeId:store.id,paymentMethodId:method.id});
    let previous={};
    if(status.configured) previous=await loadProviderCredentials(app,app.db,{tenantId:request.auth.tenantId,storeId:store.id,paymentMethodId:method.id,providerKey:TOKENPAY_PROVIDER_KEY});
    const appSecret=request.body.app_secret!==undefined?request.body.app_secret:previous.app_secret;
    if(Buffer.byteLength(String(appSecret||''),'utf8')!==32) throw errors.badRequest('TOKENPAY_APP_SECRET_INVALID','TokenPay App Secret must be exactly 32 bytes');
    const credentials={app_id:request.body.app_id.trim(),mch_id:request.body.mch_id.trim(),app_secret:String(appSecret)};
    const settings={chain:request.body.chain.trim().toUpperCase(),currency:request.body.currency.trim().toUpperCase(),expire_second:request.body.expire_second||600,locale:request.body.locale||'en'};
    if(request.body.to_address?.trim()) settings.to_address=request.body.to_address.trim();
    await app.db.transaction(async client=>{
      await saveProviderCredentials(app,client,{tenantId:request.auth.tenantId,storeId:store.id,paymentMethodId:method.id,providerKey:TOKENPAY_PROVIDER_KEY,credentials});
      await client.query(`UPDATE payment_methods SET public_config=public_config||$1::jsonb,updated_at=now() WHERE id=$2`,[JSON.stringify(settings),method.id]);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'payment.provider.configure',targetType:'payment_method',targetId:method.id,metadata:{provider_key:TOKENPAY_PROVIDER_KEY,chain:settings.chain,currency:settings.currency,app_secret_replaced:request.body.app_secret!==undefined},requestIp:request.ip,requestId:request.id});
    });
    const updatedStatus=await providerCredentialStatus(app.db,{tenantId:request.auth.tenantId,storeId:store.id,paymentMethodId:method.id});
    return {data:{provider:{key:TOKENPAY_PROVIDER_KEY,credentials:tokenPayCredentialView(credentials),credential_status:updatedStatus,settings}}};
  });
}
