import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/core/passwords.js';
import { ALL_PERMISSIONS } from '../src/core/permissions.js';
import { ensureCustomerServicePolicy } from '../src/modules/integrations/customer-service/policy.js';

const config=loadConfig(); const app=await buildApp(config); const suffix=randomUUID().replaceAll('-','').slice(0,12);
const slug=`catalog-${suffix}`; const merchantEmail=`owner-${suffix}@example.com`; const password='Catalog-Lifecycle-Password-2026!';
let tenantId; let otherTenantId;
const j=(r)=>{try{return r.json();}catch{return null;}};
const expect=(r,s,label)=>{assert.equal(r.statusCode,s,`${label}: ${r.statusCode} ${r.body}`);return j(r);};
const req=(o)=>app.inject(o);

try{
  await app.ready(); const db=app.db; const passwordHash=await hashPassword(password);
  tenantId=randomUUID(); const storeId=randomUUID(); const merchantId=randomUUID(); const roleId=randomUUID();
  otherTenantId=randomUUID(); const otherStoreId=randomUUID(); const otherProductId=randomUUID();
  await db.transaction(async(client)=>{
    await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[tenantId,`tnt_cat_${suffix}`,slug,`Catalog Test ${suffix}`]);
    await client.query("INSERT INTO tenant_settings(tenant_id,currency) VALUES($1,'USD')",[tenantId]);
    await client.query("INSERT INTO stores(id,public_id,tenant_id,name,status,is_primary) VALUES($1,$2,$3,'Main','ACTIVE',true)",[storeId,`str_cat_${suffix}`,tenantId]);
    await ensureCustomerServicePolicy(client,tenantId,{enabled:true});
    await client.query("INSERT INTO inventory_locations(id,public_id,tenant_id,store_id,code,name,status,is_default) VALUES($1,$2,$3,$4,'MAIN','Main Inventory','ACTIVE',true)",[randomUUID(),`loc_cat_${suffix}`,tenantId,storeId]);
    await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status) VALUES($1,$2,$3,$4,$5,'Owner','ACTIVE')",[merchantId,`musr_cat_${suffix}`,tenantId,merchantEmail,passwordHash]);
    await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true)",[roleId,tenantId]);
    for(const permission of ALL_PERMISSIONS) await client.query('INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,$2)',[roleId,permission]);
    await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)',[tenantId,merchantId,roleId]);

    await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[otherTenantId,`tnt_other_${suffix}`,`other-${suffix}`,`Other ${suffix}`]);
    await client.query("INSERT INTO tenant_settings(tenant_id,currency) VALUES($1,'USD')",[otherTenantId]);
    await client.query("INSERT INTO stores(id,public_id,tenant_id,name,status,is_primary) VALUES($1,$2,$3,'Other','ACTIVE',true)",[otherStoreId,`str_other_${suffix}`,otherTenantId]);
    await client.query("INSERT INTO products(id,public_id,tenant_id,store_id,slug,name,product_type,status,base_price,currency) VALUES($1,$2,$3,$4,'other-product','Other Product','PHYSICAL','PUBLISHED',1,'USD')",[otherProductId,`prd_other_${suffix}`,otherTenantId,otherStoreId]);
    await client.query("INSERT INTO product_fulfillment_modes(tenant_id,store_id,product_id,mode) VALUES($1,$2,$3,'SHIPPING')",[otherTenantId,otherStoreId,otherProductId]);
  });

  const tenantHeaders={'x-tenant-slug':slug};
  const login=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:merchantEmail,password}}),200,'merchant login');
  const auth={authorization:`Bearer ${login.data.tokens.access_token}`};

  const category=expect(await req({method:'POST',url:'/v1/merchant/categories',headers:auth,payload:{name:'Meals',slug:'meals'}}),201,'create category').data.category;
  const product=expect(await req({method:'POST',url:'/v1/merchant/products',headers:auth,payload:{name:'Cheeseburger',slug:'cheeseburger',category_id:category.public_id,product_type:'FOOD',status:'PUBLISHED',base_price:8.5,fulfillment_modes:['LOCAL_DELIVERY','PICKUP'],track_inventory:true,sku:`BURG-${suffix}`}}),201,'create product').data.product;
  assert.equal(product.status,'PUBLISHED'); assert.ok(product.inventory.length===1);

  const variant=expect(await req({method:'POST',url:`/v1/merchant/products/${product.public_id}/variants`,headers:auth,payload:{title:'Large',sku:`BURG-L-${suffix}`,attributes:{size:'Large'},price_override:10.5,track_inventory:true}}),201,'create variant').data.variant;
  assert.equal(variant.attributes.size,'Large');

  expect(await req({method:'POST',url:`/v1/merchant/products/${product.public_id}/media`,headers:auth,payload:{media_type:'IMAGE',visibility:'PUBLIC',url:'https://cdn.example.test/burger.jpg',is_primary:true,alt_text:'Burger'}}),201,'create public media');
  expect(await req({method:'POST',url:`/v1/merchant/products/${product.public_id}/media`,headers:auth,payload:{media_type:'VIDEO',visibility:'PRIVATE',storage_key:`paid/${suffix}/recipe.mp4`}}),201,'create private media');
  const group=expect(await req({method:'POST',url:`/v1/merchant/products/${product.public_id}/modifier-groups`,headers:auth,payload:{name:'Extras',required:false,min_selections:0,max_selections:2}}),201,'create modifier group').data.modifier_group;
  expect(await req({method:'POST',url:`/v1/merchant/products/${product.public_id}/modifier-groups/${group.public_id}/options`,headers:auth,payload:{name:'Bacon',price_delta:2}}),201,'create modifier option');

  const inventory=expect(await req({method:'GET',url:'/v1/merchant/inventory',headers:auth}),200,'inventory list').data.inventory;
  const simpleItem=inventory.find((row)=>row.product_id===product.public_id && row.variant_id===null);
  assert.ok(simpleItem,'simple inventory item missing');
  expect(await req({method:'POST',url:'/v1/merchant/inventory/adjustments',headers:auth,payload:{inventory_item_id:simpleItem.inventory_item_id,movement_type:'RECEIVE',quantity:25,reason:'Initial stock'}}),201,'receive inventory');
  const ledger=expect(await req({method:'GET',url:`/v1/merchant/inventory/ledger?inventory_item_id=${encodeURIComponent(simpleItem.inventory_item_id)}`,headers:auth}),200,'inventory ledger').data.ledger;
  assert.equal(ledger[0].on_hand_after,25);

  const merchantDetail=expect(await req({method:'GET',url:`/v1/merchant/products/${product.public_id}`,headers:auth}),200,'merchant product detail').data.product;
  assert.ok(merchantDetail.media.some((m)=>m.visibility==='PRIVATE'&&m.storage_key));
  assert.equal(merchantDetail.modifier_groups[0].options[0].name,'Bacon');

  const crossTenant=expect(await req({method:'GET',url:`/v1/merchant/products/prd_other_${suffix}`,headers:auth}),404,'cross tenant product isolation');
  assert.equal(crossTenant.error.code,'PRODUCT_NOT_FOUND');

  const publicList=expect(await req({method:'GET',url:'/v1/storefront/products',headers:tenantHeaders}),200,'storefront list').data.products;
  assert.ok(publicList.some((p)=>p.slug==='cheeseburger'&&p.in_stock===true));
  const publicDetail=expect(await req({method:'GET',url:'/v1/storefront/products/cheeseburger',headers:tenantHeaders}),200,'storefront detail').data.product;
  assert.ok(publicDetail.media.length>0,'public media missing from storefront detail');
  assert.ok(publicDetail.media.every((m)=>!Object.prototype.hasOwnProperty.call(m,'storage_key')),'storefront media must omit storage_key');
  assert.ok(publicDetail.media.every((m)=>!Object.prototype.hasOwnProperty.call(m,'visibility')),'storefront public media serializer does not expose internal visibility');
  assert.equal(JSON.stringify(publicDetail).includes(`paid/${suffix}`),false,'private storage key leaked to storefront');

  const credential=expect(await req({method:'POST',url:'/v1/merchant/integrations/customer-service/credentials',headers:auth,payload:{name:'Catalog Test CS',scopes:['product.read']}}),201,'create CS credential').data;
  const serviceAuth={authorization:`Bearer ${credential.credential}`};
  const caps=expect(await req({method:'GET',url:'/v1/customer-service/capabilities',headers:serviceAuth}),200,'CS capabilities');
  assert.equal(caps.data.capabilities['product.read'],true);
  const csSearch=expect(await req({method:'GET',url:'/v1/customer-service/products?q=burger',headers:serviceAuth}),200,'CS product search').data.products;
  assert.ok(csSearch.some((p)=>p.public_id===product.public_id));
  const csDetail=expect(await req({method:'GET',url:`/v1/customer-service/products/${product.public_id}`,headers:serviceAuth}),200,'CS product detail').data.product;
  assert.equal(JSON.stringify(csDetail).includes(`paid/${suffix}`),false,'private storage key leaked to CS');

  const audits=await db.query("SELECT action FROM audit_logs WHERE tenant_id=$1 AND action IN ('catalog.product.create','catalog.variant.create','inventory.adjustment.create')",[tenantId]);
  const actions=new Set(audits.rows.map(r=>r.action)); for(const action of ['catalog.product.create','catalog.variant.create','inventory.adjustment.create']) assert.ok(actions.has(action),`missing audit ${action}`);

  console.log('PASS live PostgreSQL catalog, variants, modifiers, media, and inventory lifecycle');
  console.log('PASS storefront exposes published public-safe catalog data only');
  console.log('PASS cross-tenant merchant product lookup is isolated');
  console.log('PASS Luke CS product.read search/detail excludes private media');
  console.log('PASS inventory movement and catalog audit events are durable');
} finally {
  if(tenantId) await app.db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
  if(otherTenantId) await app.db.query('DELETE FROM tenants WHERE id=$1',[otherTenantId]).catch(()=>{});
  await app.close().catch(()=>{});
}
