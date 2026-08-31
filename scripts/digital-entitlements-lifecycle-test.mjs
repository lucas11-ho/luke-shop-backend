import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/core/passwords.js';
import { ALL_PERMISSIONS } from '../src/core/permissions.js';
import { ensureStoreCommerceDefaults } from '../src/modules/commerce/defaults.js';
import { deleteAsset } from '../src/modules/assets/storage.js';

const config=loadConfig();
const app=await buildApp(config);
const suffix=randomUUID().replaceAll('-','').slice(0,12);
const slug=`digital-e2e-${suffix}`;
const password='Digital-Entitlement-2026!';
const ownerEmail=`owner-${suffix}@example.com`;
const buyerEmail=`buyer-${suffix}@example.com`;
const otherEmail=`other-${suffix}@example.com`;
let tenantId;
let storageKey;

const json=r=>{try{return r.json();}catch{return null;}};
const expect=(r,status,label)=>{assert.equal(r.statusCode,status,`${label}: ${r.statusCode} ${r.body}`);return json(r);};
const req=o=>app.inject(o);
const authHeader=token=>({authorization:`Bearer ${token}`});
const pngBytes=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x00]);

try{
  await app.ready();
  const db=app.db;
  tenantId=randomUUID();
  const storeId=randomUUID(),ownerId=randomUUID(),ownerRoleId=randomUUID();
  const passwordHash=await hashPassword(password);

  await db.transaction(async client=>{
    await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[tenantId,`tnt_digital_${suffix}`,slug,`Digital E2E ${suffix}`]);
    await client.query("INSERT INTO tenant_settings(tenant_id,currency,timezone) VALUES($1,'USD','UTC')",[tenantId]);
    await client.query("INSERT INTO stores(id,public_id,tenant_id,name,status,is_primary) VALUES($1,$2,$3,'Main','ACTIVE',true)",[storeId,`str_digital_${suffix}`,tenantId]);
    await client.query("INSERT INTO inventory_locations(id,public_id,tenant_id,store_id,code,name,status,is_default) VALUES($1,$2,$3,$4,'MAIN','Main Inventory','ACTIVE',true)",[randomUUID(),`loc_digital_${suffix}`,tenantId,storeId]);
    await ensureStoreCommerceDefaults(client,{tenantId,storeId});
    await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status,password_changed_at) VALUES($1,$2,$3,$4,$5,'Owner','ACTIVE',now())",[ownerId,`musr_digital_${suffix}`,tenantId,ownerEmail,passwordHash]);
    await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true)",[ownerRoleId,tenantId]);
    for(const permission of ALL_PERMISSIONS)await client.query('INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,$2)',[ownerRoleId,permission]);
    await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)',[tenantId,ownerId,ownerRoleId]);
  });

  const tenantHeaders={'x-tenant-slug':slug};
  const ownerLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:ownerEmail,password}}),200,'owner login');
  const ownerAuth=authHeader(ownerLogin.data.tokens.access_token);

  const manual=expect(await req({method:'POST',url:'/v1/merchant/payment-methods',headers:ownerAuth,payload:{code:`DIGITAL_${suffix}`,name:'Digital manual payment',provider_type:'MANUAL',status:'ACTIVE',sort_order:7}}),201,'create manual payment method').data.payment_method;
  const product=expect(await req({method:'POST',url:'/v1/merchant/products',headers:ownerAuth,payload:{name:'Protected Digital Image',slug:`protected-digital-${suffix}`,product_type:'DIGITAL_IMAGE',status:'PUBLISHED',base_price:19.95,fulfillment_modes:['DIGITAL_ACCESS'],track_inventory:false}}),201,'create digital product').data.product;
  expect(await req({method:'PUT',url:`/v1/merchant/products/${product.public_id}/digital-policy`,headers:ownerAuth,payload:{access_mode:'VIEW_AND_DOWNLOAD',download_limit:1}}),200,'set digital policy');

  const upload=expect(await req({method:'POST',url:'/v1/merchant/assets/upload?filename=protected.png&visibility=PRIVATE',headers:{...ownerAuth,'content-type':'image/png'},payload:pngBytes}),201,'upload private purchased asset').data.asset;
  assert.equal(upload.visibility,'PRIVATE');assert.equal(upload.media_type,'IMAGE');assert.equal(upload.url,null);
  storageKey=(await db.query('SELECT storage_key FROM media_assets WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3',[tenantId,storeId,upload.public_id])).rows[0]?.storage_key||null;
  expect(await req({method:'POST',url:`/v1/merchant/products/${product.public_id}/media`,headers:ownerAuth,payload:{asset_id:upload.public_id,sort_order:0,is_primary:false}}),201,'attach private purchased asset');

  const buyer=expect(await req({method:'POST',url:'/v1/customer/auth/register',headers:tenantHeaders,payload:{email:buyerEmail,password,display_name:'Digital Buyer'}}),201,'register buyer');
  const buyerAuth=authHeader(buyer.data.tokens.access_token);
  const other=expect(await req({method:'POST',url:'/v1/customer/auth/register',headers:tenantHeaders,payload:{email:otherEmail,password,display_name:'Other Customer'}}),201,'register other customer');
  const otherAuth=authHeader(other.data.tokens.access_token);

  expect(await req({method:'POST',url:'/v1/customer/cart/items',headers:buyerAuth,payload:{product_id:product.public_id,quantity:1,fulfillment_mode:'DIGITAL_ACCESS'}}),201,'add digital item');
  const checkout=expect(await req({method:'POST',url:'/v1/customer/checkout',headers:buyerAuth,payload:{idempotency_key:`digital-e2e-${suffix}`,payment_method_id:manual.id}}),201,'digital-only checkout without shipping').data.order;
  assert.equal(checkout.status,'PENDING_PAYMENT');assert.equal(checkout.payment_status,'PENDING');

  const entitlement=(await db.query(`SELECT e.id,e.public_id,e.status,e.access_mode,e.download_limit,e.download_count,o.id AS order_internal_id,o.public_id AS order_public_id,o.status AS order_status,o.payment_status FROM order_digital_entitlements e JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id AND o.store_id=e.store_id WHERE e.tenant_id=$1 AND e.store_id=$2 AND o.public_id=$3`,[tenantId,storeId,checkout.id])).rows[0];
  assert.ok(entitlement,'digital entitlement missing after checkout');
  assert.equal(entitlement.status,'PENDING');assert.equal(entitlement.access_mode,'VIEW_AND_DOWNLOAD');assert.equal(Number(entitlement.download_limit),1);assert.equal(Number(entitlement.download_count),0);
  const frozenAssets=await db.query('SELECT a.public_id,a.status,ea.sort_order FROM order_digital_entitlement_assets ea JOIN media_assets a ON a.id=ea.asset_id WHERE ea.tenant_id=$1 AND ea.store_id=$2 AND ea.entitlement_id=$3',[tenantId,storeId,entitlement.id]);
  assert.equal(frozenAssets.rowCount,1);assert.equal(frozenAssets.rows[0].public_id,upload.public_id);

  let library=expect(await req({method:'GET',url:'/v1/customer/library',headers:buyerAuth}),200,'pending library').data.library;
  let item=library.find(row=>row.id===entitlement.public_id);assert.ok(item,'pending entitlement not visible in library');assert.equal(item.status,'PENDING');assert.equal(item.can_view,false);assert.equal(item.can_download,false);assert.equal(item.assets.length,1);
  const pendingDenied=expect(await req({method:'POST',url:`/v1/customer/library/${entitlement.public_id}/assets/${upload.public_id}/access`,headers:buyerAuth,payload:{mode:'VIEW'}}),403,'pending entitlement access denied');assert.equal(pendingDenied.error.code,'DIGITAL_ACCESS_NOT_ACTIVE');

  expect(await req({method:'POST',url:`/v1/merchant/orders/${checkout.id}/payment/confirm`,headers:ownerAuth,payload:{provider_reference:`MANUAL-${suffix}`}}),200,'confirm payment');
  library=expect(await req({method:'GET',url:'/v1/customer/library',headers:buyerAuth}),200,'active library').data.library;
  item=library.find(row=>row.id===entitlement.public_id);assert.ok(item,'active entitlement missing');assert.equal(item.status,'ACTIVE');assert.equal(item.can_view,true);assert.equal(item.can_download,true);

  const otherDenied=expect(await req({method:'POST',url:`/v1/customer/library/${entitlement.public_id}/assets/${upload.public_id}/access`,headers:otherAuth,payload:{mode:'VIEW'}}),404,'other customer ownership denied');assert.equal(otherDenied.error.code,'DIGITAL_CONTENT_NOT_FOUND');

  const viewAccess=expect(await req({method:'POST',url:`/v1/customer/library/${entitlement.public_id}/assets/${upload.public_id}/access`,headers:buyerAuth,payload:{mode:'VIEW'}}),200,'create secure view access').data.access;
  assert.equal(viewAccess.mode,'VIEW');assert.ok(viewAccess.content_path.startsWith('/v1/digital/content/'));
  let content=await req({method:'GET',url:viewAccess.content_path});assert.equal(content.statusCode,200,`view content: ${content.statusCode} ${content.body}`);assert.match(String(content.headers['cache-control']||''),/private, no-store/);assert.match(String(content.headers['content-disposition']||''),/^inline;/);assert.match(String(content.headers['content-type']||''),/^image\/png/);assert.equal(Number(content.headers['content-length']),pngBytes.length);

  expect(await req({method:'DELETE',url:`/v1/merchant/assets/${upload.public_id}`,headers:ownerAuth}),200,'deactivate original Media asset');
  const mediaState=(await db.query(`SELECT a.status AS asset_status,pm.status AS product_media_status,COUNT(ea.asset_id)::int AS frozen_count FROM media_assets a LEFT JOIN product_media pm ON pm.asset_id=a.id AND pm.tenant_id=a.tenant_id AND pm.store_id=a.store_id LEFT JOIN order_digital_entitlement_assets ea ON ea.asset_id=a.id AND ea.tenant_id=a.tenant_id AND ea.store_id=a.store_id WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.public_id=$3 GROUP BY a.id,pm.status`,[tenantId,storeId,upload.public_id])).rows[0];
  assert.equal(mediaState.asset_status,'INACTIVE');assert.equal(mediaState.product_media_status,'INACTIVE');assert.equal(Number(mediaState.frozen_count),1);
  const viewAfterDeactivate=expect(await req({method:'POST',url:`/v1/customer/library/${entitlement.public_id}/assets/${upload.public_id}/access`,headers:buyerAuth,payload:{mode:'VIEW'}}),200,'frozen purchase survives source asset deactivation').data.access;
  content=await req({method:'GET',url:viewAfterDeactivate.content_path});assert.equal(content.statusCode,200,'frozen content bytes remain available after source deactivation');

  const download=expect(await req({method:'POST',url:`/v1/customer/library/${entitlement.public_id}/assets/${upload.public_id}/access`,headers:buyerAuth,payload:{mode:'DOWNLOAD'}}),200,'first permitted download').data.access;
  content=await req({method:'GET',url:download.content_path});assert.equal(content.statusCode,200,'download content');assert.match(String(content.headers['content-disposition']||''),/^attachment;/);
  const limitDenied=expect(await req({method:'POST',url:`/v1/customer/library/${entitlement.public_id}/assets/${upload.public_id}/access`,headers:buyerAuth,payload:{mode:'DOWNLOAD'}}),403,'download limit enforced');assert.equal(limitDenied.error.code,'DIGITAL_DOWNLOAD_LIMIT_REACHED');
  let dbEntitlement=(await db.query('SELECT status,download_count FROM order_digital_entitlements WHERE id=$1',[entitlement.id])).rows[0];assert.equal(Number(dbEntitlement.download_count),1);
  const accessEvents=await db.query('SELECT event_type,COUNT(*)::int AS count FROM digital_access_events WHERE tenant_id=$1 AND store_id=$2 AND entitlement_id=$3 GROUP BY event_type',[tenantId,storeId,entitlement.id]);
  const eventCounts=Object.fromEntries(accessEvents.rows.map(row=>[row.event_type,Number(row.count)]));assert.ok((eventCounts.VIEW||0)>=2);assert.equal(eventCounts.DOWNLOAD,1);

  const refund=expect(await req({method:'POST',url:`/v1/merchant/orders/${checkout.id}/refunds`,headers:ownerAuth,payload:{reason:'Digital entitlement refund gate test'}}),201,'request refund').data.refund;
  library=expect(await req({method:'GET',url:'/v1/customer/library',headers:buyerAuth}),200,'refund pending library').data.library;
  item=library.find(row=>row.id===entitlement.public_id);assert.ok(item,'refund-pending entitlement should remain visible');assert.equal(item.can_view,false);assert.equal(item.can_download,false);assert.equal(item.order_status,'REFUND_PENDING');
  const refundDenied=expect(await req({method:'POST',url:`/v1/customer/library/${entitlement.public_id}/assets/${upload.public_id}/access`,headers:buyerAuth,payload:{mode:'VIEW'}}),403,'refund pending blocks new access');assert.equal(refundDenied.error.code,'DIGITAL_ACCESS_NOT_ACTIVE');
  const signedDuringRefund=expect(await req({method:'GET',url:viewAfterDeactivate.content_path}),403,'refund pending blocks existing signed link');assert.equal(signedDuringRefund.error.code,'DIGITAL_ACCESS_NOT_ACTIVE');

  expect(await req({method:'PATCH',url:`/v1/merchant/refunds/${refund.id}`,headers:ownerAuth,payload:{status:'FAILED',failure_code:'CI_DECLINED',failure_message:'Simulated provider failure'}}),200,'failed refund restores paid state');
  library=expect(await req({method:'GET',url:'/v1/customer/library',headers:buyerAuth}),200,'library restored after failed refund').data.library;
  item=library.find(row=>row.id===entitlement.public_id);assert.ok(item);assert.equal(item.can_view,true);assert.equal(item.can_download,false);assert.equal(item.order_status,'PAID');
  const restoredView=expect(await req({method:'POST',url:`/v1/customer/library/${entitlement.public_id}/assets/${upload.public_id}/access`,headers:buyerAuth,payload:{mode:'VIEW'}}),200,'view restored after failed refund').data.access;

  const finalRefund=expect(await req({method:'POST',url:`/v1/merchant/orders/${checkout.id}/refunds`,headers:ownerAuth,payload:{reason:'Final digital revoke test'}}),201,'request final refund').data.refund;
  expect(await req({method:'PATCH',url:`/v1/merchant/refunds/${finalRefund.id}`,headers:ownerAuth,payload:{status:'SUCCEEDED',provider_reference:`RFND-${suffix}`}}),200,'complete final refund');
  library=expect(await req({method:'GET',url:'/v1/customer/library',headers:buyerAuth}),200,'library after successful refund').data.library;
  assert.equal(library.some(row=>row.id===entitlement.public_id),false,'revoked entitlement must leave active/pending library');
  dbEntitlement=(await db.query('SELECT status,revoked_at,download_count FROM order_digital_entitlements WHERE id=$1',[entitlement.id])).rows[0];assert.equal(dbEntitlement.status,'REVOKED');assert.ok(dbEntitlement.revoked_at);assert.equal(Number(dbEntitlement.download_count),1);
  const revokedSigned=expect(await req({method:'GET',url:restoredView.content_path}),403,'successful refund blocks previously signed link');assert.equal(revokedSigned.error.code,'DIGITAL_ACCESS_NOT_ACTIVE');

  console.log('PASS digital checkout snapshots a PENDING entitlement and PRIVATE purchased asset');
  console.log('PASS payment activation enables owner-scoped secure view/download with protected headers');
  console.log('PASS source Media deactivation does not destroy the frozen purchased-content snapshot');
  console.log('PASS download limits are server-authoritative and audit events are recorded');
  console.log('PASS REFUND_PENDING blocks access, failed refund restores access, successful refund revokes it');
  console.log('5/5 Digital entitlement PostgreSQL lifecycle checks passed');
} finally {
  try{if(storageKey)await deleteAsset(config,storageKey);}catch{}
  try{if(tenantId)await app.db.query('DELETE FROM tenants WHERE id=$1',[tenantId]);}catch{}
  await app.close();
}
