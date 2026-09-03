import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { allowedOrderTransitions, assertOrderTransition, consumeReservations, money, orderDetails, paymentStatusFor, releaseReservations } from './service.js';
import { confirmPayment } from '../payments/service.js';
import { createMerchantNotification } from '../notifications/service.js';
import { fulfillmentDetails } from '../delivery/service.js';
import { processVipOrderCompletion } from '../loyalty/execution.js';
import { restoreVipCashbackRedemptionForOrder } from '../loyalty/redemption.js';

const orderStatuses = ['PENDING_PAYMENT','PAID','CONFIRMED','RESTAURANT_ACCEPTED','PREPARING','READY','PROCESSING','PACKED','PICKED_UP','SHIPPED','OUT_FOR_DELIVERY','ACCESS_GRANTED','AVAILABLE_FOR_DOWNLOAD','DELIVERED','COMPLETED','CANCELLED','PAYMENT_FAILED','REFUND_PENDING','REFUNDED'];
const storeHeader = (request) => request.headers['x-store-id'] || null;

export async function merchantOrderRoutes(app) {
  app.get('/v1/merchant/orders', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.ORDERS_READ)],
    schema:{querystring:{type:'object',additionalProperties:false,properties:{
      status:{type:'string',enum:orderStatuses},customer_id:{type:'string',maxLength:140},q:{type:'string',maxLength:160},limit:{type:'integer',minimum:1,maximum:200,default:50},offset:{type:'integer',minimum:0,maximum:1000000,default:0},
    }}},
  }, async(request)=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});const values=[request.auth.tenantId,store.id];let where='o.tenant_id=$1 AND o.store_id=$2';
    if(request.query.status){values.push(request.query.status);where+=` AND o.status=$${values.length}`;}
    if(request.query.customer_id){values.push(request.query.customer_id);where+=` AND c.public_id=$${values.length}`;}
    if(request.query.q){values.push(request.query.q);const p=`$${values.length}`;where+=` AND (o.order_number ILIKE '%'||${p}||'%' OR c.display_name ILIKE '%'||${p}||'%')`;}
    values.push(request.query.limit||50,request.query.offset||0);
    const result=await app.db.query(`SELECT o.public_id AS id,o.order_number,c.public_id AS customer_id,c.customer_code,c.display_name AS customer_display_name,o.order_type,o.status,o.payment_status,o.currency,o.grand_total,o.created_at,o.updated_at FROM orders o JOIN customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id WHERE ${where} ORDER BY o.created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
    return {data:{store:{id:store.public_id,name:store.name},orders:result.rows,limit:request.query.limit||50,offset:request.query.offset||0}};
  });

  app.get('/v1/merchant/orders/:orderRef',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.ORDERS_READ)]},async(request)=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const found=await app.db.query(`SELECT public_id FROM orders WHERE tenant_id=$1 AND store_id=$2 AND (public_id=$3 OR order_number=$3)`,[request.auth.tenantId,store.id,request.params.orderRef]);
    if(!found.rowCount) throw errors.notFound('ORDER_NOT_FOUND','Order not found');const order=await orderDetails(app.db,request.auth.tenantId,found.rows[0].public_id);order.fulfillments=await fulfillmentDetails(app.db,request.auth.tenantId,found.rows[0].public_id);return {data:{order:{...order,allowed_transitions:allowedOrderTransitions(order.order_type,order.status)}}};
  });

  app.post('/v1/merchant/orders/:orderRef/transition',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.ORDERS_MANAGE)],
    schema:{body:{type:'object',additionalProperties:false,required:['status'],properties:{status:{type:'string',enum:orderStatuses},reason:{type:'string',maxLength:2000}}}},
  },async(request)=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const publicOrderId=await app.db.transaction(async(client)=>{
      const found=await client.query(`SELECT * FROM orders WHERE tenant_id=$1 AND store_id=$2 AND (public_id=$3 OR order_number=$3) FOR UPDATE`,[request.auth.tenantId,store.id,request.params.orderRef]);
      if(!found.rowCount) throw errors.notFound('ORDER_NOT_FOUND','Order not found');const order=found.rows[0];const toStatus=request.body.status;
      if(order.status===toStatus) return order.public_id;
      assertOrderTransition(order.order_type,order.status,toStatus);
      if(toStatus==='PAID'){
        const payment=await client.query(`SELECT id FROM order_payments WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`,[request.auth.tenantId,store.id,order.id]);
        if(payment.rowCount){await confirmPayment(client,{tenantId:request.auth.tenantId,storeId:store.id,order,requestId:request.id});await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'order.transition',targetType:'order',targetId:order.id,metadata:{order_number:order.order_number,from_status:order.status,to_status:'PAID',payment_status:'PAID'},requestIp:request.ip,requestId:request.id});return order.public_id;}
        await consumeReservations(client,{tenantId:request.auth.tenantId,storeId:store.id,orderId:order.id,requestId:request.id});
      }
      if(toStatus==='CANCELLED') {await releaseReservations(client,{tenantId:request.auth.tenantId,storeId:store.id,orderId:order.id,requestId:request.id});await client.query(`UPDATE order_payments SET status='CANCELLED',cancelled_at=now(),updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN ('PENDING','PROCESSING','FAILED')`,[request.auth.tenantId,store.id,order.id]);await client.query(`UPDATE order_fulfillments SET status='CANCELLED',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('DELIVERED','COMPLETED','CANCELLED')`,[request.auth.tenantId,store.id,order.id]);await restoreVipCashbackRedemptionForOrder(client,{tenantId:request.auth.tenantId,storeId:store.id,orderId:order.id,restorationKey:`CANCEL:${order.public_id}`,reason:'VIP cashback restored after merchant cancellation'});}
      const paymentStatus=paymentStatusFor(toStatus,order.payment_status);
      const reservationExpiry=['PAID','CANCELLED'].includes(toStatus)?'NULL':'reservation_expires_at';
      const paidAt=toStatus==='PAID'?'now()':'paid_at';const cancelledAt=toStatus==='CANCELLED'?'now()':'cancelled_at';const completedAt=['COMPLETED','REFUNDED'].includes(toStatus)?'now()':'completed_at';
      await client.query(`UPDATE orders SET status=$1,payment_status=$2,reservation_expires_at=${reservationExpiry},paid_at=${paidAt},cancelled_at=${cancelledAt},completed_at=${completedAt},updated_at=now() WHERE id=$3`,[toStatus,paymentStatus,order.id]);
      await client.query(`INSERT INTO order_status_history(tenant_id,store_id,order_id,from_status,to_status,reason,actor_type,actor_id,request_id) VALUES($1,$2,$3,$4,$5,$6,'MERCHANT',$7,$8)`,[request.auth.tenantId,store.id,order.id,order.status,toStatus,request.body.reason||null,request.auth.actorId,request.id]);
      if(toStatus==='COMPLETED'){
        const redemption=await client.query(`SELECT amount FROM vip_reward_redemptions WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status='APPLIED'`,[request.auth.tenantId,store.id,order.id]);
        const redemptionAmount=money(redemption.rows[0]?.amount||0);
        await processVipOrderCompletion(client,{tenantId:request.auth.tenantId,storeId:store.id,order:{...order,status:'COMPLETED',discount_total:money(Number(order.discount_total||0)+redemptionAmount)}});
      }
      await createMerchantNotification(client,{tenantId:request.auth.tenantId,storeId:store.id,type:'ORDER_STATUS_CHANGED',title:`Order ${order.order_number} updated`,message:`${order.status.replace(/_/g,' ')} → ${toStatus.replace(/_/g,' ')}`,orderId:order.id,customerId:order.customer_id,payload:{order_id:order.public_id,order_number:order.order_number,from_status:order.status,to_status:toStatus,order_type:order.order_type}});
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'order.transition',targetType:'order',targetId:order.id,metadata:{order_number:order.order_number,from_status:order.status,to_status:toStatus,payment_status:paymentStatus},requestIp:request.ip,requestId:request.id});
      return order.public_id;
    });
    const updated=await orderDetails(app.db,request.auth.tenantId,publicOrderId);updated.fulfillments=await fulfillmentDetails(app.db,request.auth.tenantId,publicOrderId);return {data:{order:{...updated,allowed_transitions:allowedOrderTransitions(updated.order_type,updated.status)}}};
  });
}
