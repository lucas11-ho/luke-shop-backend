import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { loadProviderCredentials } from './provider-credentials.js';
import { resolveSettlementQuote } from './settlement-quote.js';
import { createTokenPayPrepayment, TOKENPAY_PROVIDER_KEY } from './providers/tokenpay.js';

const upper=value=>String(value||'').trim().toUpperCase();
const clamp=(value,min,max,fallback)=>{const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(Math.trunc(n),max)):fallback;};

function paymentUrls(app, method, order){
  const apiBase=String(app.config.paymentPublicBaseUrl||'').replace(/\/$/,'');
  const webBase=String(app.config.customerWebBaseUrl||'').replace(/\/$/,'');
  if(!apiBase||!webBase) throw errors.unavailable('PAYMENT_PUBLIC_URLS_UNAVAILABLE','Payment callback and customer return URLs are not configured');
  if(app.config.production&&(!apiBase.startsWith('https://')||!webBase.startsWith('https://'))){
    throw errors.unavailable('PAYMENT_PUBLIC_URLS_INSECURE','Payment callback and customer return URLs must use HTTPS in production');
  }
  return {
    notifyUrl:`${apiBase}/v1/payments/webhooks/tokenpay/${encodeURIComponent(method.public_id)}`,
    returnUrl:`${webBase}/#/orders/${encodeURIComponent(order.public_id)}?payment_return=tokenpay`,
  };
}

async function stageAttempt(app,{tenantId,customerId,orderRef,idempotencyKey}){
  return app.db.transaction(async client=>{
    const found=await client.query(`SELECT o.*,op.id AS payment_db_id,op.public_id AS payment_public_id,op.status AS payment_status_live,
        op.payment_method_id,op.provider_reference,op.metadata AS payment_metadata,
        pm.public_id AS method_public_id,pm.code AS method_code,pm.name AS method_name,pm.provider_type,pm.provider_key,pm.public_config
      FROM orders o
      JOIN order_payments op ON op.tenant_id=o.tenant_id AND op.store_id=o.store_id AND op.order_id=o.id
      LEFT JOIN payment_methods pm ON pm.tenant_id=op.tenant_id AND pm.store_id=op.store_id AND pm.id=op.payment_method_id
      WHERE o.tenant_id=$1 AND o.customer_id=$2 AND (o.public_id=$3 OR o.order_number=$3)
      FOR UPDATE OF o,op`,[tenantId,customerId,orderRef]);
    if(!found.rowCount) throw errors.notFound('ORDER_NOT_FOUND','Order payment not found');
    const order=found.rows[0];
    if(order.payment_status_live==='PAID'||order.payment_status==='PAID') return {complete:true,order};
    if(!['PENDING_PAYMENT','PAYMENT_FAILED'].includes(order.status)) throw errors.conflict('PAYMENT_SESSION_ORDER_STATE_INVALID','Order is not awaiting payment');
    if(!order.payment_method_id) throw errors.conflict('PAYMENT_METHOD_NOT_CONFIGURED','Order has no payment method');
    if(order.provider_type!=='EXTERNAL') return {nonExternal:true,order};
    if(upper(order.provider_key)!==TOKENPAY_PROVIDER_KEY) throw errors.conflict('PAYMENT_PROVIDER_UNSUPPORTED','External payment provider is not supported');

    const duplicate=await client.query(`SELECT * FROM payment_attempts WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND idempotency_key=$4 LIMIT 1`,[tenantId,order.store_id,order.payment_db_id,idempotencyKey]);
    if(duplicate.rowCount){
      const existing=duplicate.rows[0];
      if(existing.status==='PROCESSING'&&existing.response_summary?.payment_url) return {existing:true,order,attempt:existing};
      if(existing.status==='SUCCEEDED') return {existing:true,order,attempt:existing};
      if(existing.status==='PROCESSING') throw errors.conflict('PAYMENT_SESSION_PROCESSING','Payment session creation is already in progress');
      if(existing.status==='FAILED') throw errors.conflict('PAYMENT_SESSION_IDEMPOTENCY_REPLAY','Previous payment session request with this idempotency key failed; retry with a new key');
    }

    let attempt=(await client.query(`SELECT * FROM payment_attempts WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`,[tenantId,order.store_id,order.payment_db_id])).rows[0];
    if(attempt?.status==='PROCESSING'){
      if(attempt.response_summary?.payment_url) return {existing:true,order,attempt};
      throw errors.conflict('PAYMENT_SESSION_PROCESSING','Payment session creation is already in progress');
    }
    if(!attempt||attempt.status!=='CREATED'){
      const next=(await client.query(`SELECT COALESCE(max(attempt_no),0)::int+1 AS n FROM payment_attempts WHERE payment_id=$1`,[order.payment_db_id])).rows[0].n;
      const inserted=await client.query(`INSERT INTO payment_attempts(id,public_id,tenant_id,store_id,payment_id,attempt_no,status,idempotency_key,request_summary)
        VALUES($1,$2,$3,$4,$5,$6,'CREATED',$7,$8::jsonb) RETURNING *`,[
          uuid(),publicId('pat'),tenantId,order.store_id,order.payment_db_id,next,idempotencyKey,
          JSON.stringify({source:'customer_payment_session',provider_key:TOKENPAY_PROVIDER_KEY}),
        ]);
      attempt=inserted.rows[0];
    }else{
      await client.query(`UPDATE payment_attempts SET idempotency_key=$1,request_summary=request_summary||$2::jsonb WHERE id=$3`,[
        idempotencyKey,JSON.stringify({source:'customer_payment_session',provider_key:TOKENPAY_PROVIDER_KEY}),attempt.id,
      ]);
      attempt={...attempt,idempotency_key:idempotencyKey};
    }
    await client.query(`UPDATE payment_attempts SET status='PROCESSING' WHERE id=$1`,[attempt.id]);
    await client.query(`UPDATE order_payments SET status='PROCESSING',failure_code=NULL,failure_message=NULL,failed_at=NULL,updated_at=now() WHERE id=$1`,[order.payment_db_id]);
    return {order,attempt:{...attempt,status:'PROCESSING'}};
  });
}

async function failStagedSession(app,order,attempt,error){
  await app.db.transaction(async client=>{
    await client.query(`UPDATE payment_attempts SET status='FAILED',failure_code=$1,failure_message=$2,completed_at=now() WHERE id=$3 AND status='PROCESSING'`,[error?.code||'TOKENPAY_SESSION_FAILED',String(error?.message||'TokenPay session failed').slice(0,500),attempt.id]);
    await client.query(`UPDATE order_payments SET status=CASE WHEN status='PROCESSING' THEN 'PENDING' ELSE status END,failure_code=$1,failure_message=$2,updated_at=now() WHERE id=$3`,[error?.code||'TOKENPAY_SESSION_FAILED',String(error?.message||'TokenPay session failed').slice(0,500),order.payment_db_id]);
  });
}

export async function createCustomerPaymentSession(app,{tenantId,customerId,orderRef,idempotencyKey}){
  const staged=await stageAttempt(app,{tenantId,customerId,orderRef,idempotencyKey});
  if(staged.complete) return {action:'NONE',status:'PAID'};
  if(staged.nonExternal) return {action:'NONE',status:staged.order.payment_status_live||'PENDING'};
  const {order,attempt}=staged;
  if(staged.existing&&attempt?.response_summary?.payment_url){
    return {action:'REDIRECT',status:'PROCESSING',url:attempt.response_summary.payment_url,provider_reference:attempt.provider_reference||order.provider_reference||null,expires_at:attempt.response_summary.expires_at||null,settlement_quote:attempt.response_summary.settlement_quote||attempt.request_summary?.settlement_quote||null};
  }
  if(staged.existing&&attempt?.status==='SUCCEEDED') return {action:'NONE',status:'PAID'};

  try{
    const providerConfig=order.public_config&&typeof order.public_config==='object'?order.public_config:{};
    const configuredCurrency=upper(providerConfig.currency);
    if(!configuredCurrency) throw errors.conflict('PAYMENT_SETTLEMENT_CONFIG_INVALID','TokenPay settlement currency is not configured');
    const credentials=await loadProviderCredentials(app,app.db,{tenantId,storeId:order.store_id,paymentMethodId:order.payment_method_id,providerKey:TOKENPAY_PROVIDER_KEY});
    const settlementQuote=resolveSettlementQuote({order,providerCurrency:configuredCurrency,settlementPolicy:credentials.settlement});
    await app.db.query(`UPDATE payment_attempts SET request_summary=request_summary||$1::jsonb WHERE id=$2`,[JSON.stringify({settlement_quote:settlementQuote}),attempt.id]);
    const urls=paymentUrls(app,{public_id:order.method_public_id},order);
    const remainingSeconds=order.reservation_expires_at?Math.floor((new Date(order.reservation_expires_at).getTime()-Date.now())/1000):1800;
    if(remainingSeconds<60) throw errors.conflict('PAYMENT_RESERVATION_EXPIRED','Inventory reservation is too close to expiry to create a payment session');
    const expireSecond=Math.min(clamp(providerConfig.expire_second,60,86400,600),remainingSeconds);
    const result=await createTokenPayPrepayment({credentials,config:providerConfig,order,attemptRef:attempt.public_id,notifyUrl:urls.notifyUrl,returnUrl:urls.returnUrl,expireSecond,settlementAmount:settlementQuote.target_amount});
    const expiresAt=new Date(Date.now()+result.expires_in*1000).toISOString();
    const settlementSnapshot={...settlementQuote,expires_at:expiresAt};
    await app.db.transaction(async client=>{
      await client.query(`UPDATE payment_attempts SET status='PROCESSING',provider_reference=$1,response_summary=$2::jsonb WHERE id=$3`,[
        result.prepay_id,JSON.stringify({provider:'TOKENPAY',payment_url:result.payment_url,request_id:result.request_id,expires_at:expiresAt,settlement_quote:settlementSnapshot}),attempt.id,
      ]);
      await client.query(`UPDATE order_payments SET status='PROCESSING',provider_reference=$1,metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$3`,[
        result.prepay_id,JSON.stringify({gateway:'TOKENPAY',session_expires_at:expiresAt,settlement_quote:settlementSnapshot}),order.payment_db_id,
      ]);
    });
    return {action:'REDIRECT',status:'PROCESSING',url:result.payment_url,provider_reference:result.prepay_id,expires_at:expiresAt,settlement_quote:settlementSnapshot};
  }catch(error){
    await failStagedSession(app,order,attempt,error);
    throw error;
  }
}
