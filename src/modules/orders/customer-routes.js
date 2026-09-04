import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { createOrderPayment } from '../payments/service.js';
import { createZeroValueRewardSettlement } from '../payments/zero-settlement.js';
import { createOrderFulfillments, resolveDeliverySelection } from '../delivery/service.js';
import { applyPromotionToTotals, resolvePromotion } from '../promotions/service.js';
import { createMerchantNotification } from '../notifications/service.js';
import { expireDueVipRewards } from '../loyalty/execution.js';
import { applyVipCashbackRedemption, restoreVipCashbackRedemptionForOrder } from '../loyalty/redemption.js';
import {
  assertOrderTransition, cartDetails, consumeReservations, getOrCreateActiveCart, makeOrderNumber, money, orderDetails,
  orderTypeFor, releaseReservations, validateCartItem,
} from './service.js';

const storeHeader = (request) => request.headers['x-store-id'] || null;
const fulfillmentSchema = { type:'string', enum:['SHIPPING','LOCAL_DELIVERY','PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','NONE'] };
const addressSchema = {
  type:'object', additionalProperties:false, required:['recipient_name','country_code','city','address_line_1'], properties:{
    recipient_name:{type:'string',minLength:1,maxLength:160}, phone:{type:'string',maxLength:60}, country_code:{type:'string',pattern:'^[A-Z]{2}$'},
    state:{type:'string',maxLength:160}, city:{type:'string',minLength:1,maxLength:160}, postal_code:{type:'string',maxLength:40},
    address_line_1:{type:'string',minLength:1,maxLength:300}, address_line_2:{type:'string',maxLength:300}, delivery_note:{type:'string',maxLength:1000},
    latitude:{type:['number','null'],minimum:-90,maximum:90}, longitude:{type:['number','null'],minimum:-180,maximum:180}, accuracy_meters:{type:['number','null'],minimum:0,maximum:100000}, location_source:{type:['string','null'],enum:['GPS','MAP_PIN','ADDRESS',null]}, formatted_address:{type:['string','null'],maxLength:600},
  },
};

async function storeWithCurrency(db, tenantId, requestedStore) {
  const store = await resolveStore(db, tenantId, requestedStore);
  const settings = await db.query('SELECT currency FROM tenant_settings WHERE tenant_id=$1', [tenantId]);
  if (!settings.rowCount) throw errors.conflict('TENANT_SETTINGS_MISSING', 'Tenant settings are missing');
  return { ...store, currency: settings.rows[0].currency };
}

async function activeCartForUpdate(client, tenantId, storeId, customerId) {
  const found = await client.query(`SELECT * FROM carts WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND status='ACTIVE' FOR UPDATE`, [tenantId,storeId,customerId]);
  if (!found.rowCount) throw errors.notFound('CART_NOT_FOUND','Active cart not found');
  return found.rows[0];
}

export async function customerOrderRoutes(app) {
  app.get('/v1/customer/cart', { preHandler:[app.requireCustomerAuth] }, async(request)=>{
    const store = await storeWithCurrency(app.db, request.auth.tenantId, storeHeader(request));
    const result = await app.db.transaction(async(client)=>{
      const cart = await getOrCreateActiveCart(client,{tenantId:request.auth.tenantId,store,customerId:request.auth.actorId,publicId,uuid});
      return cart.public_id;
    });
    return { data:{ cart: await cartDetails(app.db,request.auth.tenantId,store.id,request.auth.actorId,result) } };
  });

  app.post('/v1/customer/cart/items', {
    preHandler:[app.requireCustomerAuth],
    schema:{body:{type:'object',additionalProperties:false,required:['product_id','quantity','fulfillment_mode'],properties:{
      product_id:{type:'string',minLength:1,maxLength:140}, variant_id:{type:'string',maxLength:140}, quantity:{type:'integer',minimum:1,maximum:1000},
      fulfillment_mode:fulfillmentSchema, modifier_option_ids:{type:'array',maxItems:50,uniqueItems:true,items:{type:'string',maxLength:140}},
    }}},
  }, async(request,reply)=>{
    const store = await storeWithCurrency(app.db,request.auth.tenantId,storeHeader(request));
    const cartPublicId = await app.db.transaction(async(client)=>{
      const cart = await getOrCreateActiveCart(client,{tenantId:request.auth.tenantId,store,customerId:request.auth.actorId,publicId,uuid});
      if (new Date(cart.expires_at) <= new Date()) throw errors.conflict('CART_EXPIRED','Cart has expired');
      const validated = await validateCartItem(client,{tenantId:request.auth.tenantId,storeId:store.id,productRef:request.body.product_id,variantRef:request.body.variant_id||null,
        quantity:request.body.quantity,fulfillmentMode:request.body.fulfillment_mode,modifierOptionIds:request.body.modifier_option_ids||[]});
      if (validated.product.currency !== store.currency) throw errors.conflict('CART_CURRENCY_MISMATCH','Product currency does not match tenant currency');
      await client.query(`INSERT INTO cart_items(id,public_id,tenant_id,store_id,cart_id,product_id,variant_id,quantity,fulfillment_mode,title_snapshot,variant_title_snapshot,sku_snapshot,unit_price,modifier_total,selected_modifiers,line_total,currency)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
        [uuid(),publicId('citem'),request.auth.tenantId,store.id,cart.id,validated.product.id,validated.variant?.id||null,request.body.quantity,request.body.fulfillment_mode,
          validated.product.name,validated.variant?.title||null,validated.variant?.sku||null,validated.unitPrice,validated.modifierTotal,JSON.stringify(validated.selectedModifiers),validated.lineTotal,validated.product.currency]);
      await client.query('UPDATE carts SET updated_at=now(),expires_at=now()+interval \'30 days\' WHERE id=$1',[cart.id]);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'cart.item.add',targetType:'cart',targetId:cart.id,metadata:{product_id:validated.product.public_id,quantity:request.body.quantity},requestIp:request.ip,requestId:request.id});
      return cart.public_id;
    });
    return reply.code(201).send({data:{cart:await cartDetails(app.db,request.auth.tenantId,store.id,request.auth.actorId,cartPublicId)}});
  });

  app.patch('/v1/customer/cart/items/:itemId', {
    preHandler:[app.requireCustomerAuth], schema:{body:{type:'object',additionalProperties:false,required:['quantity'],properties:{quantity:{type:'integer',minimum:1,maximum:1000}}}},
  }, async(request)=>{
    const store=await storeWithCurrency(app.db,request.auth.tenantId,storeHeader(request));
    const cartPublicId=await app.db.transaction(async(client)=>{
      const cart=await activeCartForUpdate(client,request.auth.tenantId,store.id,request.auth.actorId);
      const item=await client.query(`SELECT ci.*,p.public_id AS product_ref,v.public_id AS variant_ref FROM cart_items ci JOIN products p ON p.id=ci.product_id AND p.tenant_id=ci.tenant_id AND p.store_id=ci.store_id LEFT JOIN product_variants v ON v.id=ci.variant_id AND v.tenant_id=ci.tenant_id AND v.store_id=ci.store_id WHERE ci.tenant_id=$1 AND ci.store_id=$2 AND ci.cart_id=$3 AND ci.public_id=$4 FOR UPDATE OF ci`,[request.auth.tenantId,store.id,cart.id,request.params.itemId]);
      if(!item.rowCount) throw errors.notFound('CART_ITEM_NOT_FOUND','Cart item not found');
      const modifierIds=(item.rows[0].selected_modifiers||[]).map((m)=>m.id);
      const validated=await validateCartItem(client,{tenantId:request.auth.tenantId,storeId:store.id,productRef:item.rows[0].product_ref,variantRef:item.rows[0].variant_ref,quantity:request.body.quantity,fulfillmentMode:item.rows[0].fulfillment_mode,modifierOptionIds:modifierIds});
      await client.query('UPDATE cart_items SET quantity=$1,unit_price=$2,modifier_total=$3,selected_modifiers=$4::jsonb,line_total=$5,updated_at=now() WHERE id=$6',[request.body.quantity,validated.unitPrice,validated.modifierTotal,JSON.stringify(validated.selectedModifiers),validated.lineTotal,item.rows[0].id]);
      await client.query('UPDATE carts SET updated_at=now() WHERE id=$1',[cart.id]);
      return cart.public_id;
    });
    return {data:{cart:await cartDetails(app.db,request.auth.tenantId,store.id,request.auth.actorId,cartPublicId)}};
  });

  app.delete('/v1/customer/cart/items/:itemId',{preHandler:[app.requireCustomerAuth]},async(request,reply)=>{
    const store=await storeWithCurrency(app.db,request.auth.tenantId,storeHeader(request));
    const cartPublicId=await app.db.transaction(async(client)=>{
      const cart=await activeCartForUpdate(client,request.auth.tenantId,store.id,request.auth.actorId);
      const deleted=await client.query('DELETE FROM cart_items WHERE tenant_id=$1 AND store_id=$2 AND cart_id=$3 AND public_id=$4 RETURNING id',[request.auth.tenantId,store.id,cart.id,request.params.itemId]);
      if(!deleted.rowCount) throw errors.notFound('CART_ITEM_NOT_FOUND','Cart item not found');
      await client.query('UPDATE carts SET updated_at=now() WHERE id=$1',[cart.id]);return cart.public_id;
    });
    return reply.code(200).send({data:{removed:true,cart:await cartDetails(app.db,request.auth.tenantId,store.id,request.auth.actorId,cartPublicId)}});
  });

  app.post('/v1/customer/checkout',{
    preHandler:[app.requireCustomerAuth],
    schema:{body:{type:'object',additionalProperties:false,required:['idempotency_key'],properties:{
      idempotency_key:{type:'string',minLength:8,maxLength:160},shipping_address:{anyOf:[addressSchema,{type:'null'}]},customer_note:{type:'string',maxLength:2000},
      payment_method_id:{type:'string',maxLength:140},delivery_method_id:{type:'string',maxLength:140},promotion_code:{type:'string',maxLength:80},payment_reference:{type:'string',maxLength:240},vip_cashback_amount:{type:'number',minimum:0,maximum:1000000},
    }}},
  },async(request,reply)=>{
    const store=await storeWithCurrency(app.db,request.auth.tenantId,storeHeader(request));
    const result=await app.db.transaction(async(client)=>{
      const existing=await client.query(`SELECT o.public_id,o.order_number FROM checkout_sessions cs JOIN orders o ON o.checkout_session_id=cs.id AND o.tenant_id=cs.tenant_id AND o.store_id=cs.store_id WHERE cs.tenant_id=$1 AND cs.customer_id=$2 AND cs.idempotency_key=$3 AND cs.status='COMPLETED'`,[request.auth.tenantId,request.auth.actorId,request.body.idempotency_key]);
      if(existing.rowCount) return {existing:true,...existing.rows[0]};
      const cart=await activeCartForUpdate(client,request.auth.tenantId,store.id,request.auth.actorId);
      if(new Date(cart.expires_at)<=new Date()) throw errors.conflict('CART_EXPIRED','Cart has expired');
      const rows=await client.query(`SELECT ci.*,p.public_id AS product_ref,p.product_type,p.category_id,p.status AS product_status,v.public_id AS variant_ref FROM cart_items ci JOIN products p ON p.id=ci.product_id AND p.tenant_id=ci.tenant_id AND p.store_id=ci.store_id LEFT JOIN product_variants v ON v.id=ci.variant_id AND v.tenant_id=ci.tenant_id AND v.store_id=ci.store_id WHERE ci.tenant_id=$1 AND ci.store_id=$2 AND ci.cart_id=$3 ORDER BY ci.created_at,ci.id FOR UPDATE OF ci`,[request.auth.tenantId,store.id,cart.id]);
      if(!rows.rowCount) throw errors.badRequest('CART_EMPTY','Cart is empty');
      const needsAddress=rows.rows.some((row)=>['SHIPPING','LOCAL_DELIVERY'].includes(row.fulfillment_mode));
      if(needsAddress&&!request.body.shipping_address) throw errors.badRequest('SHIPPING_ADDRESS_REQUIRED','Shipping or local delivery requires an address');
      for(const item of rows.rows){
        const modifierIds=(item.selected_modifiers||[]).map((m)=>m.id);
        const current=await validateCartItem(client,{tenantId:request.auth.tenantId,storeId:store.id,productRef:item.product_ref,variantRef:item.variant_ref,quantity:item.quantity,fulfillmentMode:item.fulfillment_mode,modifierOptionIds:modifierIds});
        if(money(current.lineTotal)!==money(item.line_total)||money(current.unitPrice)!==money(item.unit_price)||money(current.modifierTotal)!==money(item.modifier_total)) throw errors.conflict('CART_PRICE_CHANGED','Product or modifier pricing changed; refresh the cart before checkout');
      }
      const subtotal=money(rows.rows.reduce((sum,row)=>sum+Number(row.line_total),0));
      const deliverySelection=await resolveDeliverySelection(client,{tenantId:request.auth.tenantId,storeId:store.id,cartItems:rows.rows,subtotal,deliveryMethodRef:request.body.delivery_method_id||null,shippingAddress:request.body.shipping_address||null});
      const promotionResult=await resolvePromotion(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:request.auth.actorId,items:rows.rows,subtotal,promotionCode:request.body.promotion_code||null});
      const promotionTotals=applyPromotionToTotals({promotionResult,deliveryTotal:deliverySelection.deliveryTotal});
      const discountTotal=money(promotionTotals.discountTotal);const deliveryTotal=money(Math.max(0,deliverySelection.deliveryTotal-promotionTotals.deliveryDiscount));
      const payableBeforeRedemption=money(Math.max(0,subtotal-discountTotal+deliveryTotal));const requestedVipCashback=money(request.body.vip_cashback_amount||0);
      const checkoutId=uuid();const checkoutPublicId=publicId('chk');
      await client.query(`INSERT INTO checkout_sessions(id,public_id,tenant_id,store_id,customer_id,cart_id,idempotency_key,status,currency,subtotal,discount_total,delivery_total,grand_total,shipping_address,customer_note)
        VALUES($1,$2,$3,$4,$5,$6,$7,'CREATED',$8,$9,$10,$11,$12,$13::jsonb,$14)`,[checkoutId,checkoutPublicId,request.auth.tenantId,store.id,request.auth.actorId,cart.id,request.body.idempotency_key,store.currency,subtotal,discountTotal,deliveryTotal,payableBeforeRedemption,request.body.shipping_address?JSON.stringify(request.body.shipping_address):null,request.body.customer_note?.trim()||null]);
      const orderId=uuid();const orderPublicId=publicId('ord');const orderNumber=makeOrderNumber();const orderType=orderTypeFor(rows.rows.map((row)=>row.product_type));
      await client.query(`INSERT INTO orders(id,public_id,order_number,tenant_id,store_id,customer_id,checkout_session_id,order_type,status,payment_status,currency,subtotal,discount_total,delivery_total,grand_total,customer_note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING_PAYMENT','PENDING',$9,$10,$11,$12,$13,$14)`,[orderId,orderPublicId,orderNumber,request.auth.tenantId,store.id,request.auth.actorId,checkoutId,orderType,store.currency,subtotal,discountTotal,deliveryTotal,payableBeforeRedemption,request.body.customer_note?.trim()||null]);
      let redemption=null;let grandTotal=payableBeforeRedemption;
      if(requestedVipCashback>0){await expireDueVipRewards(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:request.auth.actorId});redemption=await applyVipCashbackRedemption(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:request.auth.actorId,orderId,orderPublicId,currency:store.currency,requestedAmount:requestedVipCashback,maxAmount:payableBeforeRedemption});grandTotal=money(Math.max(0,payableBeforeRedemption-redemption.amount));await client.query('UPDATE checkout_sessions SET grand_total=$1,updated_at=now() WHERE id=$2',[grandTotal,checkoutId]);await client.query('UPDATE orders SET grand_total=$1,updated_at=now() WHERE id=$2',[grandTotal,orderId]);}
      if(request.body.shipping_address){const a=request.body.shipping_address;await client.query(`INSERT INTO order_addresses(order_id,tenant_id,store_id,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,formatted_address,latitude,longitude,accuracy_meters,location_source,location_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CASE WHEN $14::double precision IS NULL OR $15::double precision IS NULL THEN NULL ELSE now() END)`,[orderId,request.auth.tenantId,store.id,a.recipient_name,a.phone||null,a.country_code,a.state||null,a.city,a.postal_code||null,a.address_line_1,a.address_line_2||null,a.delivery_note||null,a.formatted_address||null,a.latitude??null,a.longitude??null,a.accuracy_meters??null,a.location_source||null]);if(a.latitude!=null&&a.longitude!=null){await client.query(`INSERT INTO order_delivery_location_events(tenant_id,store_id,order_id,customer_id,latitude,longitude,accuracy_meters,location_source,event_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CHECKOUT_SNAPSHOT')`,[request.auth.tenantId,store.id,orderId,request.auth.actorId,a.latitude,a.longitude,a.accuracy_meters??null,a.location_source||'GPS']);}}
      for(const item of rows.rows){
        const inventory=await client.query(`SELECT i.id,i.public_id,i.track_inventory FROM inventory_items i WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.product_id=$3 AND ${item.variant_id?'i.variant_id=$4':'i.variant_id IS NULL'} AND i.status='ACTIVE' LIMIT 1`,item.variant_id?[request.auth.tenantId,store.id,item.product_id,item.variant_id]:[request.auth.tenantId,store.id,item.product_id]);
        const tracked=inventory.rowCount&&inventory.rows[0].track_inventory;
        let stock=null;
        if(tracked){
          stock=await client.query(`SELECT b.location_id,l.public_id AS location_public_id,b.on_hand,b.reserved
             FROM inventory_balances b
             JOIN inventory_locations l ON l.id=b.location_id AND l.tenant_id=b.tenant_id AND l.store_id=b.store_id
            WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.inventory_item_id=$3 AND l.status='ACTIVE'
              AND (b.on_hand-b.reserved) >= $4
            ORDER BY l.is_default DESC,(b.on_hand-b.reserved) DESC,l.created_at ASC
            LIMIT 1 FOR UPDATE OF b`,[request.auth.tenantId,store.id,inventory.rows[0].id,item.quantity]);
          if(!stock.rowCount) throw errors.conflict('INVENTORY_INSUFFICIENT','Not enough inventory is available to checkout this cart');
        }
        const orderItemId=uuid();
        await client.query(`INSERT INTO order_items(id,public_id,tenant_id,store_id,order_id,product_id,variant_id,inventory_item_id,inventory_location_id,quantity,fulfillment_mode,product_type_snapshot,title_snapshot,variant_title_snapshot,sku_snapshot,unit_price,modifier_total,selected_modifiers,line_total,currency)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)`,[orderItemId,publicId('oitem'),request.auth.tenantId,store.id,orderId,item.product_id,item.variant_id,tracked?inventory.rows[0].id:null,tracked?stock.rows[0].location_id:null,item.quantity,item.fulfillment_mode,item.product_type,item.title_snapshot,item.variant_title_snapshot,item.sku_snapshot,item.unit_price,item.modifier_total,JSON.stringify(item.selected_modifiers||[]),item.line_total,item.currency]);
        if(tracked){
          const onHand=Number(stock.rows[0].on_hand);const reserved=Number(stock.rows[0].reserved);const nextReserved=reserved+item.quantity;
          await client.query(`UPDATE inventory_balances SET reserved=$1,updated_at=now() WHERE tenant_id=$2 AND store_id=$3 AND inventory_item_id=$4 AND location_id=$5`,[nextReserved,request.auth.tenantId,store.id,inventory.rows[0].id,stock.rows[0].location_id]);
          await client.query(`INSERT INTO inventory_reservations(id,public_id,tenant_id,store_id,order_id,order_item_id,inventory_item_id,location_id,quantity,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE')`,[uuid(),publicId('rsv'),request.auth.tenantId,store.id,orderId,orderItemId,inventory.rows[0].id,stock.rows[0].location_id,item.quantity]);
          await client.query(`INSERT INTO inventory_ledger(tenant_id,store_id,inventory_item_id,location_id,movement_type,on_hand_delta,reserved_delta,on_hand_after,reserved_after,reason,reference_type,reference_id,actor_type,request_id) VALUES($1,$2,$3,$4,'RESERVE',0,$5,$6,$7,'Order checkout reservation','ORDER',$8,'SYSTEM',$9)`,[request.auth.tenantId,store.id,inventory.rows[0].id,stock.rows[0].location_id,item.quantity,onHand,nextReserved,orderNumber,request.id]);
        }
      }
      const fullyRewardPaid=Boolean(redemption&&grandTotal===0);
      if(fullyRewardPaid){await consumeReservations(client,{tenantId:request.auth.tenantId,storeId:store.id,orderId,requestId:request.id});await client.query(`UPDATE orders SET status='PAID',payment_status='PAID',reservation_expires_at=NULL,paid_at=now(),updated_at=now() WHERE id=$1`,[orderId]);await createZeroValueRewardSettlement(client,{tenantId:request.auth.tenantId,storeId:store.id,orderId,currency:store.currency});}
      else await createOrderPayment(client,{tenantId:request.auth.tenantId,storeId:store.id,orderId,amount:grandTotal,currency:store.currency,paymentMethodRef:request.body.payment_method_id||null,customerReference:request.body.payment_reference||null});
      await createOrderFulfillments(client,{tenantId:request.auth.tenantId,storeId:store.id,orderId,cartItems:rows.rows,deliverySelection});
      if(deliverySelection.deliveryTotal>0) await client.query(`INSERT INTO order_adjustments(id,public_id,tenant_id,store_id,order_id,adjustment_type,source_id,code,description,amount) VALUES($1,$2,$3,$4,$5,'DELIVERY',$6,$7,$8,$9)`,[uuid(),publicId('adj'),request.auth.tenantId,store.id,orderId,deliverySelection.method?.id||null,deliverySelection.method?.code||null,deliverySelection.method?.name||'Delivery',deliverySelection.deliveryTotal]);
      if(promotionResult){const appliedDiscount=money(discountTotal+promotionTotals.deliveryDiscount);await client.query(`INSERT INTO promotion_redemptions(id,tenant_id,store_id,promotion_id,promotion_code_id,order_id,customer_id,discount_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[uuid(),request.auth.tenantId,store.id,promotionResult.promotion.id,promotionResult.promotionCodeId||null,orderId,request.auth.actorId,appliedDiscount]);await client.query(`INSERT INTO order_adjustments(id,public_id,tenant_id,store_id,order_id,adjustment_type,source_id,code,description,amount) VALUES($1,$2,$3,$4,$5,'PROMOTION',$6,$7,$8,$9)`,[uuid(),publicId('adj'),request.auth.tenantId,store.id,orderId,promotionResult.promotion.id,promotionResult.code||null,promotionResult.promotion.name,-appliedDiscount]);}
      if(redemption)await client.query(`INSERT INTO order_adjustments(id,public_id,tenant_id,store_id,order_id,adjustment_type,source_id,code,description,amount) VALUES($1,$2,$3,$4,$5,'VIP_REDEMPTION',$6,'VIP_CASHBACK','VIP cashback redeemed',$7)`,[uuid(),publicId('adj'),request.auth.tenantId,store.id,orderId,redemption.internal_id,-redemption.amount]);
      await createMerchantNotification(client,{tenantId:request.auth.tenantId,storeId:store.id,type:'ORDER_CREATED',title:`New ${orderType.replace(/_/g,' ').toLowerCase()} order`,message:`${orderNumber} was placed for ${store.currency} ${grandTotal.toFixed(2)}`,orderId,customerId:request.auth.actorId,payload:{order_id:orderPublicId,order_number:orderNumber,order_type:orderType,grand_total:grandTotal,currency:store.currency}});
      await client.query(`INSERT INTO order_status_history(tenant_id,store_id,order_id,from_status,to_status,reason,actor_type,actor_id,request_id) VALUES($1,$2,$3,NULL,$4,$5,'CUSTOMER',$6,$7)`,[request.auth.tenantId,store.id,orderId,fullyRewardPaid?'PAID':'PENDING_PAYMENT',fullyRewardPaid?'Checkout fully covered by VIP cashback':'Checkout created',request.auth.actorId,request.id]);
      await client.query(`UPDATE checkout_sessions SET status='COMPLETED',completed_at=now(),updated_at=now() WHERE id=$1`,[checkoutId]);
      await client.query(`UPDATE carts SET status='CHECKED_OUT',updated_at=now() WHERE id=$1`,[cart.id]);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'checkout.order.create',targetType:'order',targetId:orderId,metadata:{order_number:orderNumber,checkout_id:checkoutPublicId,subtotal,discount_total:discountTotal,delivery_total:deliveryTotal,payable_before_vip_redemption:payableBeforeRedemption,vip_cashback_redeemed:redemption?.amount||0,grand_total:grandTotal,fully_reward_paid:fullyRewardPaid,order_type:orderType,promotion_code:promotionResult?.code||null},requestIp:request.ip,requestId:request.id});
      return {existing:false,public_id:orderPublicId,order_number:orderNumber};
    });
    const [order,redemption]=await Promise.all([orderDetails(app.db,request.auth.tenantId,result.public_id,{customerId:request.auth.actorId}),app.db.query(`SELECT r.public_id AS id,r.amount,r.currency,r.status,r.created_at FROM vip_reward_redemptions r JOIN orders o ON o.id=r.order_id AND o.tenant_id=r.tenant_id AND o.store_id=r.store_id WHERE r.tenant_id=$1 AND o.public_id=$2 AND r.customer_id=$3`,[request.auth.tenantId,result.public_id,request.auth.actorId])]);
    return reply.code(result.existing?200:201).send({data:{order,vip_redemption:redemption.rows[0]||null,idempotent_replay:result.existing}});
  });

  app.get('/v1/customer/orders',{preHandler:[app.requireCustomerAuth],schema:{querystring:{type:'object',additionalProperties:false,properties:{status:{type:'string',maxLength:60},limit:{type:'integer',minimum:1,maximum:100,default:20},offset:{type:'integer',minimum:0,maximum:1000000,default:0}}}}},async(request)=>{
    const values=[request.auth.tenantId,request.auth.actorId];let where='o.tenant_id=$1 AND o.customer_id=$2';if(request.query.status){values.push(request.query.status);where+=` AND o.status=$${values.length}`;}values.push(request.query.limit||20,request.query.offset||0);
    const result=await app.db.query(`SELECT o.public_id AS id,o.order_number,s.public_id AS store_id,s.name AS store_name,o.order_type,o.status,o.payment_status,o.currency,o.grand_total,o.created_at,o.updated_at,(SELECT count(*)::int FROM order_items oi WHERE oi.tenant_id=o.tenant_id AND oi.store_id=o.store_id AND oi.order_id=o.id) AS item_count,(SELECT COALESCE(f.estimated_delivery_at,f.estimated_at) FROM order_fulfillments f WHERE f.tenant_id=o.tenant_id AND f.store_id=o.store_id AND f.order_id=o.id ORDER BY f.created_at LIMIT 1) AS estimated_at FROM orders o JOIN stores s ON s.id=o.store_id AND s.tenant_id=o.tenant_id WHERE ${where} ORDER BY o.created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
    return {data:{orders:result.rows,limit:request.query.limit||20,offset:request.query.offset||0}};
  });

  app.get('/v1/customer/orders/:orderRef',{preHandler:[app.requireCustomerAuth]},async(request)=>({data:{order:await orderDetails(app.db,request.auth.tenantId,request.params.orderRef,{customerId:request.auth.actorId})}}));

  app.post('/v1/customer/orders/:orderRef/cancel',{preHandler:[app.requireCustomerAuth],schema:{body:{type:'object',additionalProperties:false,properties:{reason:{type:'string',maxLength:1000}}}}},async(request)=>{
    const result=await app.db.transaction(async(client)=>{
      const found=await client.query(`SELECT * FROM orders WHERE tenant_id=$1 AND customer_id=$2 AND (public_id=$3 OR order_number=$3) FOR UPDATE`,[request.auth.tenantId,request.auth.actorId,request.params.orderRef]);
      if(!found.rowCount) throw errors.notFound('ORDER_NOT_FOUND','Order not found');const order=found.rows[0];assertOrderTransition(order.order_type,order.status,'CANCELLED');
      await releaseReservations(client,{tenantId:request.auth.tenantId,storeId:order.store_id,orderId:order.id,requestId:request.id});
      await client.query(`UPDATE orders SET status='CANCELLED',reservation_expires_at=NULL,cancelled_at=now(),updated_at=now() WHERE id=$1`,[order.id]);
      await client.query(`UPDATE order_payments SET status='CANCELLED',cancelled_at=now(),updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN ('PENDING','PROCESSING','FAILED')`,[request.auth.tenantId,order.store_id,order.id]);
      await client.query(`UPDATE order_fulfillments SET status='CANCELLED',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('DELIVERED','COMPLETED','CANCELLED')`,[request.auth.tenantId,order.store_id,order.id]);
      await restoreVipCashbackRedemptionForOrder(client,{tenantId:request.auth.tenantId,storeId:order.store_id,orderId:order.id,restorationKey:`CANCEL:${order.public_id}`,reason:'VIP cashback restored after customer cancellation'});
      await createMerchantNotification(client,{tenantId:request.auth.tenantId,storeId:order.store_id,type:'ORDER_STATUS_CHANGED',title:`Order ${order.order_number} cancelled`,message:'Customer cancelled the order',orderId:order.id,customerId:request.auth.actorId,payload:{order_id:order.public_id,order_number:order.order_number,from_status:order.status,to_status:'CANCELLED',order_type:order.order_type}});
      await client.query(`INSERT INTO order_status_history(tenant_id,store_id,order_id,from_status,to_status,reason,actor_type,actor_id,request_id) VALUES($1,$2,$3,$4,'CANCELLED',$5,'CUSTOMER',$6,$7)`,[request.auth.tenantId,order.store_id,order.id,order.status,request.body?.reason||null,request.auth.actorId,request.id]);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'order.cancel',targetType:'order',targetId:order.id,metadata:{order_number:order.order_number,from_status:order.status},requestIp:request.ip,requestId:request.id});return order.public_id;
    });
    return {data:{order:await orderDetails(app.db,request.auth.tenantId,result,{customerId:request.auth.actorId})}};
  });
}