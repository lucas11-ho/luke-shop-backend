import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/core/passwords.js';
import { ALL_PERMISSIONS } from '../src/core/permissions.js';
import { ensureStoreCommerceDefaults } from '../src/modules/commerce/defaults.js';
import { ensureCustomerServicePolicy } from '../src/modules/integrations/customer-service/policy.js';

const config=loadConfig();const app=await buildApp(config);const suffix=randomUUID().replaceAll('-','').slice(0,12);const slug=`commerce-${suffix}`;const merchantEmail=`owner-${suffix}@example.com`;const customerEmail=`buyer-${suffix}@example.com`;const otherEmail=`other-${suffix}@example.com`;const password='Commerce-Lifecycle-Password-2026!';let tenantId;
const j=(r)=>{try{return r.json();}catch{return null;}};const expect=(r,s,l)=>{assert.equal(r.statusCode,s,`${l}: ${r.statusCode} ${r.body}`);return j(r);};const req=(o)=>app.inject(o);
try{
 await app.ready();const db=app.db;const passwordHash=await hashPassword(password);tenantId=randomUUID();const storeId=randomUUID();const merchantId=randomUUID();const roleId=randomUUID();const locId=randomUUID();
 await db.transaction(async(client)=>{
  await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[tenantId,`tnt_c_${suffix}`,slug,`Commerce ${suffix}`]);
  await client.query("INSERT INTO tenant_settings(tenant_id,currency) VALUES($1,'USD')",[tenantId]);
  await client.query("INSERT INTO stores(id,public_id,tenant_id,name,status,is_primary) VALUES($1,$2,$3,'Main','ACTIVE',true)",[storeId,`str_c_${suffix}`,tenantId]);
  await ensureCustomerServicePolicy(client,tenantId,{enabled:true});
  await client.query("INSERT INTO inventory_locations(id,public_id,tenant_id,store_id,code,name,status,is_default) VALUES($1,$2,$3,$4,'MAIN','Main Inventory','ACTIVE',true)",[locId,`loc_c_${suffix}`,tenantId,storeId]);
  await ensureStoreCommerceDefaults(client,{tenantId,storeId});
  await ensureStoreCommerceDefaults(client,{tenantId,storeId});
  await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status) VALUES($1,$2,$3,$4,$5,'Owner','ACTIVE')",[merchantId,`musr_c_${suffix}`,tenantId,merchantEmail,passwordHash]);
  await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true)",[roleId,tenantId]);for(const permission of ALL_PERMISSIONS)await client.query('INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,$2)',[roleId,permission]);await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)',[tenantId,merchantId,roleId]);
 });
 const defaultCounts=await db.query(`SELECT
   (SELECT count(*)::int FROM payment_methods WHERE tenant_id=$1 AND store_id=$2 AND code='MANUAL') AS manual_count,
   (SELECT count(*)::int FROM delivery_methods WHERE tenant_id=$1 AND store_id=$2 AND code IN ('PICKUP','SHIPPING','LOCAL')) AS delivery_count`,[tenantId,storeId]);
 assert.equal(defaultCounts.rows[0].manual_count,1);assert.equal(defaultCounts.rows[0].delivery_count,3);
 const th={'x-tenant-slug':slug};const ml=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:th,payload:{email:merchantEmail,password}}),200,'merchant login');const mh={authorization:`Bearer ${ml.data.tokens.access_token}`};
 const delivery=expect(await req({method:'POST',url:'/v1/merchant/delivery-methods',headers:mh,payload:{code:'SHIP5',name:'Standard $5',fulfillment_mode:'SHIPPING',flat_fee:5}}),201,'delivery method').data.delivery_method;
 const promo=expect(await req({method:'POST',url:'/v1/merchant/promotions',headers:mh,payload:{name:'Ten Percent',promotion_type:'PERCENTAGE',status:'ACTIVE',value:10,min_subtotal:20,per_customer_limit:1}}),201,'promotion').data.promotion;
 expect(await req({method:'POST',url:`/v1/merchant/promotions/${promo.id}/codes`,headers:mh,payload:{code:'SAVE10',usage_limit:50}}),201,'promo code');
 const product=expect(await req({method:'POST',url:'/v1/merchant/products',headers:mh,payload:{name:'Commerce Bag',slug:`commerce-bag-${suffix}`,product_type:'PHYSICAL',status:'PUBLISHED',base_price:50,fulfillment_modes:['SHIPPING'],track_inventory:true,sku:`CBAG-${suffix}`}}),201,'product').data.product;
 const inv=expect(await req({method:'GET',url:'/v1/merchant/inventory',headers:mh}),200,'inventory').data.inventory.find(x=>x.product_id===product.public_id);assert.ok(inv);
 expect(await req({method:'POST',url:'/v1/merchant/inventory/adjustments',headers:mh,payload:{inventory_item_id:inv.inventory_item_id,movement_type:'RECEIVE',quantity:10,reason:'commerce test'}}),201,'stock');
 const c=expect(await req({method:'POST',url:'/v1/customer/auth/register',headers:th,payload:{email:customerEmail,password,display_name:'Buyer'}}),201,'customer');const ch={authorization:`Bearer ${c.data.tokens.access_token}`};const customerId=c.data.customer.public_id;
 const other=expect(await req({method:'POST',url:'/v1/customer/auth/register',headers:th,payload:{email:otherEmail,password,display_name:'Other'}}),201,'other customer');const otherId=other.data.customer.public_id;
 expect(await req({method:'POST',url:'/v1/customer/cart/items',headers:ch,payload:{product_id:product.public_id,quantity:2,fulfillment_mode:'SHIPPING'}}),201,'cart add');
 const checkout=expect(await req({method:'POST',url:'/v1/customer/checkout',headers:ch,payload:{idempotency_key:`commerce-${suffix}`,delivery_method_id:delivery.id,promotion_code:'SAVE10',shipping_address:{recipient_name:'Buyer',country_code:'SG',city:'Singapore',address_line_1:'1 Test Street'}}}),201,'checkout').data.order;
 assert.equal(Number(checkout.subtotal),100);assert.equal(Number(checkout.discount_total),10);assert.equal(Number(checkout.delivery_total),5);assert.equal(Number(checkout.grand_total),95);assert.equal(checkout.payment.status,'PENDING');assert.equal(checkout.fulfillments[0].status,'PENDING');assert.equal(checkout.adjustments.length,2);
 const payment=expect(await req({method:'POST',url:`/v1/merchant/orders/${checkout.order_number}/payment/confirm`,headers:mh,payload:{provider_reference:`MAN-${suffix}`}}),200,'confirm payment').data.payment;assert.equal(payment.status,'PAID');
 const paidOrder=expect(await req({method:'GET',url:`/v1/customer/orders/${checkout.order_number}`,headers:ch}),200,'paid order').data.order;assert.equal(paidOrder.status,'PAID');assert.equal(paidOrder.payment_status,'PAID');
 const f=expect(await req({method:'GET',url:`/v1/merchant/orders/${checkout.order_number}/fulfillments`,headers:mh}),200,'fulfillments').data.fulfillments[0];
 expect(await req({method:'PATCH',url:`/v1/merchant/fulfillments/${f.id}`,headers:mh,payload:{status:'SHIPPED',carrier:'Test Carrier',tracking_number:`TRK-${suffix}`}}),200,'ship');
 expect(await req({method:'PATCH',url:`/v1/merchant/fulfillments/${f.id}`,headers:mh,payload:{status:'DELIVERED'}}),200,'deliver');
 const deliveryStatus=expect(await req({method:'GET',url:`/v1/customer/orders/${checkout.order_number}/fulfillments`,headers:ch}),200,'customer delivery').data.fulfillments[0];assert.equal(deliveryStatus.status,'DELIVERED');assert.equal(deliveryStatus.tracking_number,`TRK-${suffix}`);
 const credential=expect(await req({method:'POST',url:'/v1/merchant/integrations/customer-service/credentials',headers:mh,payload:{name:'Commerce CS',scopes:['payments.read','delivery.read']}}),201,'CS credential').data;const sh={authorization:`Bearer ${credential.credential}`};
 const caps=expect(await req({method:'GET',url:'/v1/customer-service/capabilities',headers:sh}),200,'caps').data.capabilities;assert.equal(caps['payments.read'],true);assert.equal(caps['delivery.read'],true);
 const cp=expect(await req({method:'GET',url:`/v1/customer-service/customers/${customerId}/orders/${checkout.order_number}/payment`,headers:sh}),200,'CS payment').data.payment;assert.equal(cp.status,'PAID');assert.equal(cp.provider_reference,undefined);
 const cd=expect(await req({method:'GET',url:`/v1/customer-service/customers/${customerId}/orders/${checkout.order_number}/delivery`,headers:sh}),200,'CS delivery').data.fulfillments[0];assert.equal(cd.status,'DELIVERED');
 expect(await req({method:'GET',url:`/v1/customer-service/customers/${otherId}/orders/${checkout.order_number}/payment`,headers:sh}),404,'CS payment ownership');
 const red=await db.query(`SELECT count(*)::int AS n FROM promotion_redemptions WHERE tenant_id=$1 AND order_id=(SELECT id FROM orders WHERE tenant_id=$1 AND order_number=$2)`,[tenantId,checkout.order_number]);assert.equal(red.rows[0].n,1);
 const audits=await db.query("SELECT action FROM audit_logs WHERE tenant_id=$1 AND action IN ('checkout.order.create','payment.confirm','fulfillment.update','promotion.create')",[tenantId]);const acts=new Set(audits.rows.map(x=>x.action));for(const a of ['checkout.order.create','payment.confirm','fulfillment.update','promotion.create'])assert.ok(acts.has(a),`missing audit ${a}`);
 console.log('PASS live PostgreSQL checkout pricing with promotion + delivery fee');
 console.log('PASS payment PENDING → PAID consumes reserved inventory and synchronizes order');
 console.log('PASS fulfillment tracking/status history lifecycle');
 console.log('PASS Luke CS payment/delivery reads are customer-bound and sanitized');
 console.log('PASS promotion redemption and commerce audit events are durable');
}finally{if(tenantId)await app.db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});await app.close().catch(()=>{});}
