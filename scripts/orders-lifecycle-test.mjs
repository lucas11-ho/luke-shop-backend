import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/core/passwords.js';
import { ALL_PERMISSIONS } from '../src/core/permissions.js';
import { ensureStoreCommerceDefaults } from '../src/modules/commerce/defaults.js';
import { ensureCustomerServicePolicy } from '../src/modules/integrations/customer-service/policy.js';

const config=loadConfig(); const app=await buildApp(config); const suffix=randomUUID().replaceAll('-','').slice(0,12);
const slug=`orders-${suffix}`; const merchantEmail=`owner-${suffix}@example.com`; const customerEmail=`buyer-${suffix}@example.com`; const otherCustomerEmail=`other-${suffix}@example.com`; const password='Orders-Lifecycle-Password-2026!';
let tenantId; const j=(r)=>{try{return r.json();}catch{return null;}}; const expect=(r,s,label)=>{assert.equal(r.statusCode,s,`${label}: ${r.statusCode} ${r.body}`);return j(r);}; const req=(o)=>app.inject(o);
try{
  await app.ready(); const db=app.db; const passwordHash=await hashPassword(password);tenantId=randomUUID();const storeId=randomUUID();const merchantId=randomUUID();const roleId=randomUUID();
  await db.transaction(async(client)=>{
    await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[tenantId,`tnt_ord_${suffix}`,slug,`Orders Test ${suffix}`]);
    await client.query("INSERT INTO tenant_settings(tenant_id,currency) VALUES($1,'USD')",[tenantId]);
    await client.query("INSERT INTO stores(id,public_id,tenant_id,name,status,is_primary) VALUES($1,$2,$3,'Main','ACTIVE',true)",[storeId,`str_ord_${suffix}`,tenantId]);
    await ensureCustomerServicePolicy(client,tenantId,{enabled:true});
    await client.query("INSERT INTO inventory_locations(id,public_id,tenant_id,store_id,code,name,status,is_default) VALUES($1,$2,$3,$4,'MAIN','Main Inventory','ACTIVE',true)",[randomUUID(),`loc_ord_${suffix}`,tenantId,storeId]);
    await ensureStoreCommerceDefaults(client,{tenantId,storeId});
    await ensureStoreCommerceDefaults(client,{tenantId,storeId}); // idempotency guard
    await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status) VALUES($1,$2,$3,$4,$5,'Owner','ACTIVE')",[merchantId,`musr_ord_${suffix}`,tenantId,merchantEmail,passwordHash]);
    await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true)",[roleId,tenantId]);
    for(const permission of ALL_PERMISSIONS) await client.query('INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,$2)',[roleId,permission]);
    await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)',[tenantId,merchantId,roleId]);
  });
  const tenantHeaders={'x-tenant-slug':slug};
  const merchantLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:merchantEmail,password}}),200,'merchant login');
  const merchantAuth={authorization:`Bearer ${merchantLogin.data.tokens.access_token}`};
  const product=expect(await req({method:'POST',url:'/v1/merchant/products',headers:merchantAuth,payload:{name:'Travel Bag',slug:'travel-bag',product_type:'PHYSICAL',status:'PUBLISHED',base_price:25,fulfillment_modes:['SHIPPING','PICKUP'],track_inventory:true,sku:`BAG-${suffix}`}}),201,'create product').data.product;
  const inventory=expect(await req({method:'GET',url:'/v1/merchant/inventory',headers:merchantAuth}),200,'inventory list').data.inventory;
  const item=inventory.find((row)=>row.product_id===product.public_id);assert.ok(item,'inventory item missing');
  expect(await req({method:'POST',url:'/v1/merchant/inventory/adjustments',headers:merchantAuth,payload:{inventory_item_id:item.inventory_item_id,movement_type:'RECEIVE',quantity:10,reason:'Orders lifecycle stock'}}),201,'stock receive');

  const customer=expect(await req({method:'POST',url:'/v1/customer/auth/register',headers:tenantHeaders,payload:{email:customerEmail,password,display_name:'Buyer'}}),201,'customer register');
  const customerAuth={authorization:`Bearer ${customer.data.tokens.access_token}`};const customerId=customer.data.customer.public_id;
  const other=expect(await req({method:'POST',url:'/v1/customer/auth/register',headers:tenantHeaders,payload:{email:otherCustomerEmail,password,display_name:'Other Buyer'}}),201,'other customer register');
  const otherId=other.data.customer.public_id;

  const added=expect(await req({method:'POST',url:'/v1/customer/cart/items',headers:customerAuth,payload:{product_id:product.public_id,quantity:2,fulfillment_mode:'SHIPPING'}}),201,'cart add');
  assert.equal(added.data.cart.items[0].quantity,2);assert.equal(Number(added.data.cart.totals.grand_total),50);
  const checkoutPayload={idempotency_key:`checkout-${suffix}-1`,shipping_address:{recipient_name:'Buyer',country_code:'SG',city:'Singapore',address_line_1:'1 Test Street'}};
  const checkout=expect(await req({method:'POST',url:'/v1/customer/checkout',headers:customerAuth,payload:checkoutPayload}),201,'checkout');
  const order=checkout.data.order;assert.equal(order.status,'PENDING_PAYMENT');assert.equal(order.order_type,'PHYSICAL');assert.equal(Number(order.grand_total),50);
  const replay=expect(await req({method:'POST',url:'/v1/customer/checkout',headers:customerAuth,payload:checkoutPayload}),200,'idempotent checkout replay');assert.equal(replay.data.order.order_number,order.order_number);assert.equal(replay.data.idempotent_replay,true);
  let balance=(await db.query(`SELECT b.on_hand,b.reserved FROM inventory_balances b JOIN inventory_items i ON i.id=b.inventory_item_id AND i.tenant_id=b.tenant_id AND i.store_id=b.store_id WHERE i.tenant_id=$1 AND i.public_id=$2`,[tenantId,item.inventory_item_id])).rows[0];assert.equal(Number(balance.on_hand),10);assert.equal(Number(balance.reserved),2);

  const paid=expect(await req({method:'POST',url:`/v1/merchant/orders/${order.id}/transition`,headers:merchantAuth,payload:{status:'PAID',reason:'Test payment'}}),200,'mark paid').data.order;assert.equal(paid.status,'PAID');assert.equal(paid.payment_status,'PAID');
  balance=(await db.query(`SELECT b.on_hand,b.reserved FROM inventory_balances b JOIN inventory_items i ON i.id=b.inventory_item_id AND i.tenant_id=b.tenant_id AND i.store_id=b.store_id WHERE i.tenant_id=$1 AND i.public_id=$2`,[tenantId,item.inventory_item_id])).rows[0];assert.equal(Number(balance.on_hand),8);assert.equal(Number(balance.reserved),0);
  for(const status of ['CONFIRMED','PROCESSING','PACKED','SHIPPED','DELIVERED','COMPLETED']) expect(await req({method:'POST',url:`/v1/merchant/orders/${order.id}/transition`,headers:merchantAuth,payload:{status}}),200,`transition ${status}`);
  const customerOrder=expect(await req({method:'GET',url:`/v1/customer/orders/${order.order_number}`,headers:customerAuth}),200,'customer order detail').data.order;assert.equal(customerOrder.status,'COMPLETED');assert.equal(customerOrder.status_history.at(-1).to_status,'COMPLETED');

  expect(await req({method:'POST',url:'/v1/customer/cart/items',headers:customerAuth,payload:{product_id:product.public_id,quantity:1,fulfillment_mode:'PICKUP'}}),201,'second cart add');
  const cancelOrder=expect(await req({method:'POST',url:'/v1/customer/checkout',headers:customerAuth,payload:{idempotency_key:`checkout-${suffix}-2`}}),201,'second checkout').data.order;
  balance=(await db.query(`SELECT b.on_hand,b.reserved FROM inventory_balances b JOIN inventory_items i ON i.id=b.inventory_item_id AND i.tenant_id=b.tenant_id AND i.store_id=b.store_id WHERE i.tenant_id=$1 AND i.public_id=$2`,[tenantId,item.inventory_item_id])).rows[0];assert.equal(Number(balance.on_hand),8);assert.equal(Number(balance.reserved),1);
  const cancelled=expect(await req({method:'POST',url:`/v1/customer/orders/${cancelOrder.id}/cancel`,headers:customerAuth,payload:{reason:'Changed mind'}}),200,'customer cancel').data.order;assert.equal(cancelled.status,'CANCELLED');
  balance=(await db.query(`SELECT b.on_hand,b.reserved FROM inventory_balances b JOIN inventory_items i ON i.id=b.inventory_item_id AND i.tenant_id=b.tenant_id AND i.store_id=b.store_id WHERE i.tenant_id=$1 AND i.public_id=$2`,[tenantId,item.inventory_item_id])).rows[0];assert.equal(Number(balance.on_hand),8);assert.equal(Number(balance.reserved),0);

  const credential=expect(await req({method:'POST',url:'/v1/merchant/integrations/customer-service/credentials',headers:merchantAuth,payload:{name:'Orders Test CS',scopes:['orders.read','order_status.read']}}),201,'CS credential').data;
  const serviceAuth={authorization:`Bearer ${credential.credential}`};const caps=expect(await req({method:'GET',url:'/v1/customer-service/capabilities',headers:serviceAuth}),200,'CS capabilities');assert.equal(caps.data.capabilities['orders.read'],true);assert.equal(caps.data.capabilities['order_status.read'],true);
  const recent=expect(await req({method:'GET',url:`/v1/customer-service/customers/${customerId}/orders`,headers:serviceAuth}),200,'CS recent orders').data.orders;assert.ok(recent.some((row)=>row.order_number===order.order_number));
  const csStatus=expect(await req({method:'GET',url:`/v1/customer-service/customers/${customerId}/orders/${order.order_number}/status`,headers:serviceAuth}),200,'CS order status').data.order;assert.equal(csStatus.status,'COMPLETED');
  expect(await req({method:'GET',url:`/v1/customer-service/customers/${otherId}/orders/${order.order_number}/status`,headers:serviceAuth}),404,'CS ownership isolation');

  const audits=await db.query("SELECT action FROM audit_logs WHERE tenant_id=$1 AND action IN ('checkout.order.create','order.transition','order.cancel')",[tenantId]);const actions=new Set(audits.rows.map((r)=>r.action));for(const action of ['checkout.order.create','order.transition','order.cancel']) assert.ok(actions.has(action),`missing audit ${action}`);
  const movements=await db.query("SELECT movement_type FROM inventory_ledger WHERE tenant_id=$1 AND reference_type='ORDER'",[tenantId]);const movementTypes=new Set(movements.rows.map((r)=>r.movement_type));for(const movement of ['RESERVE','SALE','RELEASE']) assert.ok(movementTypes.has(movement),`missing inventory movement ${movement}`);

  console.log('PASS live PostgreSQL cart → checkout → idempotent order lifecycle');
  console.log('PASS inventory RESERVE → SALE and cancellation RELEASE semantics');
  console.log('PASS physical order state machine and durable status history');
  console.log('PASS customer order ownership and Luke CS customer+order isolation');
  console.log('PASS checkout/order/inventory audit trail is durable');
} finally {
  if(tenantId) await app.db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
  await app.close().catch(()=>{});
}
