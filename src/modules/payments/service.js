import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { assertOrderTransition, consumeReservations } from '../orders/service.js';

export async function resolvePaymentMethod(client, tenantId, storeId, paymentMethodRef = null) {
  const params=[tenantId,storeId]; let filter="tenant_id=$1 AND store_id=$2 AND status='ACTIVE'";
  if(paymentMethodRef){params.push(paymentMethodRef);filter+=` AND (public_id=$${params.length} OR code=$${params.length})`;}
  else filter+=" AND code='MANUAL'";
  const result=await client.query(`SELECT * FROM payment_methods WHERE ${filter} ORDER BY sort_order,created_at LIMIT 1`,params);
  if(!result.rowCount) throw errors.notFound('PAYMENT_METHOD_NOT_FOUND','Active payment method not found');
  return result.rows[0];
}

export async function createOrderPayment(client,{tenantId,storeId,orderId,amount,currency,paymentMethodRef=null,customerReference=null}){
  const method=await resolvePaymentMethod(client,tenantId,storeId,paymentMethodRef);
  if(method.provider_type==='CASH_ON_DELIVERY'){
    const eligible=await client.query(`SELECT 1 FROM order_items WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND fulfillment_mode IN ('SHIPPING','LOCAL_DELIVERY') LIMIT 1`,[tenantId,storeId,orderId]);
    if(!eligible.rowCount) throw errors.badRequest('CASH_ON_DELIVERY_NOT_AVAILABLE','Cash on delivery requires a shipping or local-delivery item');
    // COD inventory remains reserved until merchant reconciliation confirms payment.
    // Clearing only the expiry prevents the generic unpaid-order sweeper from releasing
    // goods that are legitimately being prepared and delivered for cash collection.
    await client.query(`UPDATE orders SET reservation_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tenantId,storeId,orderId]);
  }
  const paymentId=uuid();
  const result=await client.query(`INSERT INTO order_payments(id,public_id,tenant_id,store_id,order_id,payment_method_id,status,amount,currency,customer_reference)
    VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9) RETURNING *`,[paymentId,publicId('pay'),tenantId,storeId,orderId,method.id,amount,currency,customerReference||null]);
  await client.query(`INSERT INTO payment_attempts(id,public_id,tenant_id,store_id,payment_id,attempt_no,status,request_summary)
    VALUES($1,$2,$3,$4,$5,1,'CREATED',$6::jsonb)`,[uuid(),publicId('pat'),tenantId,storeId,paymentId,JSON.stringify({method_code:method.code,provider_type:method.provider_type})]);
  return {...result.rows[0],method};
}

export async function paymentDetails(db,tenantId,orderRef,{customerId=null}={}){
  const params=[tenantId,orderRef];let customerFilter='';if(customerId){params.push(customerId);customerFilter=` AND o.customer_id=$${params.length}`;}
  const payment=await db.query(`SELECT op.public_id AS id,op.status,op.amount,op.currency,op.provider_reference,op.customer_reference,
      op.failure_code,op.failure_message,op.paid_at,op.failed_at,op.cancelled_at,op.refunded_amount,op.created_at,op.updated_at,
      pm.public_id AS payment_method_id,pm.code AS payment_method_code,pm.name AS payment_method_name,pm.provider_type,pm.provider_key,
      o.public_id AS order_id,o.order_number
    FROM order_payments op JOIN orders o ON o.id=op.order_id AND o.tenant_id=op.tenant_id AND o.store_id=op.store_id
    LEFT JOIN payment_methods pm ON pm.id=op.payment_method_id AND pm.tenant_id=op.tenant_id AND pm.store_id=op.store_id
    WHERE op.tenant_id=$1 AND (o.public_id=$2 OR o.order_number=$2)${customerFilter} LIMIT 1`,params);
  if(!payment.rowCount) throw errors.notFound('PAYMENT_NOT_FOUND','Payment not found');
  const attempts=await db.query(`SELECT pa.public_id AS id,pa.attempt_no,pa.status,pa.provider_reference,pa.failure_code,pa.failure_message,pa.created_at,pa.completed_at
    FROM payment_attempts pa JOIN order_payments op ON op.id=pa.payment_id AND op.tenant_id=pa.tenant_id AND op.store_id=pa.store_id
    WHERE pa.tenant_id=$1 AND op.public_id=$2 ORDER BY pa.attempt_no`,[tenantId,payment.rows[0].id]);
  return {...payment.rows[0],attempts:attempts.rows};
}

export async function confirmPayment(client,{tenantId,storeId,order,providerReference=null,requestId=null}){
  if(order.status!=='PENDING_PAYMENT'&&order.status!=='PAYMENT_FAILED') throw errors.conflict('PAYMENT_ORDER_STATE_INVALID','Order is not awaiting payment');
  assertOrderTransition(order.order_type,order.status,'PAID');
  const payment=await client.query(`SELECT * FROM order_payments WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE`,[tenantId,storeId,order.id]);
  if(!payment.rowCount) throw errors.notFound('PAYMENT_NOT_FOUND','Order payment not found');
  if(payment.rows[0].status==='PAID') return payment.rows[0];
  await consumeReservations(client,{tenantId,storeId,orderId:order.id,requestId});
  await client.query(`UPDATE order_payments SET status='PAID',provider_reference=COALESCE($1,provider_reference),failure_code=NULL,failure_message=NULL,paid_at=now(),updated_at=now() WHERE id=$2`,[providerReference,payment.rows[0].id]);
  await client.query(`UPDATE payment_attempts SET status='SUCCEEDED',provider_reference=COALESCE($1,provider_reference),completed_at=now() WHERE payment_id=$2 AND attempt_no=(SELECT max(attempt_no) FROM payment_attempts WHERE payment_id=$2)`,[providerReference,payment.rows[0].id]);
  await client.query(`UPDATE orders SET status='PAID',payment_status='PAID',reservation_expires_at=NULL,paid_at=now(),updated_at=now() WHERE id=$1`,[order.id]);
  await client.query(`INSERT INTO order_status_history(tenant_id,store_id,order_id,from_status,to_status,reason,actor_type,request_id) VALUES($1,$2,$3,$4,'PAID','Payment confirmed','SYSTEM',$5)`,[tenantId,storeId,order.id,order.status,requestId]);
  return (await client.query('SELECT * FROM order_payments WHERE id=$1',[payment.rows[0].id])).rows[0];
}

export async function failPayment(client,{tenantId,storeId,order,failureCode=null,failureMessage=null,requestId=null}){
  if(order.status!=='PENDING_PAYMENT') throw errors.conflict('PAYMENT_ORDER_STATE_INVALID','Order is not pending payment');
  assertOrderTransition(order.order_type,order.status,'PAYMENT_FAILED');
  const payment=await client.query(`SELECT * FROM order_payments WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE`,[tenantId,storeId,order.id]);
  if(!payment.rowCount) throw errors.notFound('PAYMENT_NOT_FOUND','Order payment not found');
  await client.query(`UPDATE order_payments SET status='FAILED',failure_code=$1,failure_message=$2,failed_at=now(),updated_at=now() WHERE id=$3`,[failureCode,failureMessage,payment.rows[0].id]);
  await client.query(`UPDATE payment_attempts SET status='FAILED',failure_code=$1,failure_message=$2,completed_at=now() WHERE payment_id=$3 AND attempt_no=(SELECT max(attempt_no) FROM payment_attempts WHERE payment_id=$3)`,[failureCode,failureMessage,payment.rows[0].id]);
  await client.query(`UPDATE orders SET status='PAYMENT_FAILED',payment_status='FAILED',updated_at=now() WHERE id=$1`,[order.id]);
  await client.query(`INSERT INTO order_status_history(tenant_id,store_id,order_id,from_status,to_status,reason,actor_type,request_id) VALUES($1,$2,$3,$4,'PAYMENT_FAILED',$5,'SYSTEM',$6)`,[tenantId,storeId,order.id,order.status,failureMessage||failureCode||'Payment failed',requestId]);
  return payment.rows[0];
}
