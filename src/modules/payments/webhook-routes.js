import crypto from 'node:crypto';
import { errors } from '../../core/errors.js';
import { confirmPayment } from './service.js';
import { loadProviderCredentials } from './provider-credentials.js';
import { decryptTokenPayResource, tokenPayNotificationAmount, tokenPayNotificationCurrency, tokenPayNotificationOutcome, verifyTokenPayMessage, TOKENPAY_PROVIDER_KEY } from './providers/tokenpay.js';

const upper=value=>String(value||'').trim().toUpperCase();
const digest=value=>crypto.createHash('sha256').update(String(value||''),'utf8').digest('hex');
const numericEqual=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Math.abs(Number(a)-Number(b))<1e-8;

async function rejectEvent(app,{method,eventId,eventType,summary,requestId}){
  await app.db.query(`INSERT INTO payment_events(tenant_id,store_id,provider_key,provider_event_id,event_type,payload_summary,outcome,request_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,'REJECTED',$7) ON CONFLICT(tenant_id,provider_key,provider_event_id) DO NOTHING`,[
      method.tenant_id,method.store_id,TOKENPAY_PROVIDER_KEY,eventId,eventType,JSON.stringify(summary),requestId,
    ]);
}

export async function paymentWebhookRoutes(app){
  app.post('/v1/payments/webhooks/tokenpay/:paymentMethodRef',{config:{rateLimit:{max:120,timeWindow:'1 minute'}},schema:{params:{type:'object',required:['paymentMethodRef'],properties:{paymentMethodRef:{type:'string',minLength:4,maxLength:120}}}}},async(request,reply)=>{
    const rawBody=typeof request.rawBody==='string'?request.rawBody:JSON.stringify(request.body||{});
    const event=request.body&&typeof request.body==='object'?request.body:{};
    const eventId=String(event.id||event.request_id||`sha256:${digest(rawBody)}`).slice(0,240);
    const eventType=String(event.event_type||'TOKENPAY.NOTIFICATION').slice(0,120);
    const methodResult=await app.db.query(`SELECT * FROM payment_methods WHERE public_id=$1 AND provider_type='EXTERNAL' AND upper(COALESCE(provider_key,''))='TOKENPAY' LIMIT 1`,[request.params.paymentMethodRef]);
    if(!methodResult.rowCount) throw errors.notFound('PAYMENT_METHOD_NOT_FOUND','TokenPay payment method not found');
    const method=methodResult.rows[0];
    const credentials=await loadProviderCredentials(app,app.db,{tenantId:method.tenant_id,storeId:method.store_id,paymentMethodId:method.id,providerKey:TOKENPAY_PROVIDER_KEY});
    const timestamp=request.headers['ttpay-timestamp'],nonce=request.headers['ttpay-nonce'],signature=request.headers['ttpay-signature'];
    if(!verifyTokenPayMessage({timestamp,nonce,body:rawBody,signature,appSecret:credentials.app_secret})){
      await rejectEvent(app,{method,eventId,eventType,summary:{reason:'SIGNATURE_INVALID'},requestId:request.id});
      throw errors.unauthorized('TOKENPAY_SIGNATURE_INVALID','TokenPay callback signature verification failed');
    }
    if(event.app_id&&String(event.app_id)!==String(credentials.app_id)){
      await rejectEvent(app,{method,eventId,eventType,summary:{reason:'APP_ID_MISMATCH'},requestId:request.id});
      throw errors.badRequest('TOKENPAY_APP_ID_MISMATCH','TokenPay callback App ID does not match configured credentials');
    }
    if(event.mch_id&&String(event.mch_id)!==String(credentials.mch_id)){
      await rejectEvent(app,{method,eventId,eventType,summary:{reason:'MERCHANT_ID_MISMATCH'},requestId:request.id});
      throw errors.badRequest('TOKENPAY_MERCHANT_ID_MISMATCH','TokenPay callback Merchant ID does not match configured credentials');
    }
    const resource=decryptTokenPayResource(event.resource,credentials.app_secret);
    const attemptRef=String(resource.out_trade_no||resource.merchant_order_no||resource.order_no||'').trim();
    if(!attemptRef){
      await rejectEvent(app,{method,eventId,eventType,summary:{reason:'ORDER_REFERENCE_MISSING'},requestId:request.id});
      throw errors.badRequest('TOKENPAY_ORDER_REFERENCE_MISSING','TokenPay callback did not contain the Shope payment attempt reference');
    }
    const found=await app.db.query(`SELECT pa.id AS attempt_id,pa.public_id AS attempt_public_id,pa.payment_id,
        op.id AS payment_db_id,op.status AS payment_status,op.amount,op.currency,op.payment_method_id,
        o.*
      FROM payment_attempts pa
      JOIN order_payments op ON op.tenant_id=pa.tenant_id AND op.store_id=pa.store_id AND op.id=pa.payment_id
      JOIN orders o ON o.tenant_id=op.tenant_id AND o.store_id=op.store_id AND o.id=op.order_id
      WHERE pa.tenant_id=$1 AND pa.store_id=$2 AND pa.public_id=$3 AND op.payment_method_id=$4 LIMIT 1`,[
        method.tenant_id,method.store_id,attemptRef,method.id,
      ]);
    if(!found.rowCount){
      await rejectEvent(app,{method,eventId,eventType,summary:{reason:'ATTEMPT_NOT_FOUND',attempt_ref:attemptRef},requestId:request.id});
      throw errors.notFound('TOKENPAY_PAYMENT_ATTEMPT_NOT_FOUND','TokenPay callback payment attempt was not found');
    }
    const payment=found.rows[0];
    const providerReference=String(resource.transaction_id||resource.prepay_id||resource.id||'').trim()||null;
    const outcome=tokenPayNotificationOutcome(event,resource);
    const amount=tokenPayNotificationAmount(resource),currency=tokenPayNotificationCurrency(resource);
    const summary={attempt_ref:attemptRef,provider_reference:providerReference,event_type:eventType,outcome,amount:Number.isFinite(amount)?amount:null,currency:currency||null,state:String(resource.trade_state||resource.status||resource.payment_status||'').slice(0,80)};

    const inserted=await app.db.query(`INSERT INTO payment_events(tenant_id,store_id,payment_id,provider_key,provider_event_id,event_type,payload_summary,outcome,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'RECEIVED',$8)
      ON CONFLICT(tenant_id,provider_key,provider_event_id) DO NOTHING RETURNING id`,[
        method.tenant_id,method.store_id,payment.payment_db_id,TOKENPAY_PROVIDER_KEY,eventId,eventType,JSON.stringify(summary),request.id,
      ]);
    if(!inserted.rowCount) return reply.type('text/plain').send('success');
    const paymentEventId=inserted.rows[0].id;

    if(payment.payment_status==='PAID'){
      await app.db.query(`UPDATE payment_events SET outcome='IGNORED' WHERE id=$1`,[paymentEventId]);
      return reply.type('text/plain').send('success');
    }
    if(outcome!=='SUCCESS'){
      await app.db.query(`UPDATE payment_events SET outcome='IGNORED' WHERE id=$1`,[paymentEventId]);
      return reply.type('text/plain').send('success');
    }
    if(!Number.isFinite(amount)||!currency||!numericEqual(payment.amount,amount)||upper(payment.currency)!==currency){
      await app.db.query(`UPDATE payment_events SET outcome='REJECTED',payload_summary=payload_summary||$1::jsonb WHERE id=$2`,[
        JSON.stringify({reason:'AMOUNT_OR_CURRENCY_MISMATCH',expected_amount:Number(payment.amount),expected_currency:upper(payment.currency)}),paymentEventId,
      ]);
      throw errors.badRequest('TOKENPAY_AMOUNT_MISMATCH','TokenPay callback amount or currency does not match the Shope order');
    }

    await app.db.transaction(async client=>{
      const locked=await client.query(`SELECT * FROM orders WHERE id=$1 AND tenant_id=$2 AND store_id=$3 FOR UPDATE`,[payment.id,method.tenant_id,method.store_id]);
      if(!locked.rowCount) throw errors.notFound('ORDER_NOT_FOUND','Order not found');
      const order=locked.rows[0];
      if(order.payment_status==='PAID'){
        await client.query(`UPDATE payment_events SET outcome='IGNORED' WHERE id=$1`,[paymentEventId]);
        return;
      }
      await confirmPayment(client,{tenantId:method.tenant_id,storeId:method.store_id,order,providerReference,requestId:request.id});
      await client.query(`UPDATE payment_events SET outcome='APPLIED' WHERE id=$1`,[paymentEventId]);
    });
    return reply.type('text/plain').send('success');
  });
}
