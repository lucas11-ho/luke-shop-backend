import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore, resolveProduct } from '../catalog/service.js';
import { productFulfillmentPolicy, isDigitalProductType } from '../catalog/product-policy.js';
import { fetchR2Asset, statLocalAsset, streamLocalAsset } from '../assets/storage.js';
import {
  authorizeDigitalAssetAccess, createDigitalContentToken, customerDigitalLibrary,
  resolveSignedDigitalContent, verifyDigitalContentToken,
} from './service.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const ACCESS_MODES=['VIEW_ONLY','DOWNLOAD_ONLY','VIEW_AND_DOWNLOAD'];

async function sendProtectedAsset(app,request,reply,asset,mode){
  reply.header('Accept-Ranges','bytes')
    .header('Cache-Control','private, no-store')
    .header('Cross-Origin-Resource-Policy','cross-origin')
    .header('Content-Disposition',`${mode==='DOWNLOAD'?'attachment':'inline'}; filename="content"; filename*=UTF-8''${encodeURIComponent(asset.original_filename||'content')}`)
    .type(asset.mime_type);
  const range=request.headers.range||'';
  if(asset.storage_provider==='R2'){
    const remote=await fetchR2Asset(app.config,asset.storage_key,{range}).catch(()=>null);
    if(!remote)throw errors.notFound('DIGITAL_CONTENT_BYTES_NOT_FOUND','Digital content bytes were not found');
    if(remote.status===206){reply.code(206);if(remote.contentRange)reply.header('Content-Range',remote.contentRange);}
    if(remote.size)reply.header('Content-Length',String(remote.size));
    return reply.send(remote.body);
  }
  if(asset.storage_provider!=='LOCAL')throw errors.unavailable('DIGITAL_STORAGE_UNAVAILABLE','Digital storage provider is unavailable');
  const stat=await statLocalAsset(app.config,asset.storage_key).catch(()=>null);
  if(!stat)throw errors.notFound('DIGITAL_CONTENT_BYTES_NOT_FOUND','Digital content bytes were not found');
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match)return reply.code(416).header('Content-Range',`bytes */${stat.size}`).send();
    let start=match[1]?Number(match[1]):0;let end=match[2]?Number(match[2]):stat.size-1;
    if(!match[1]&&match[2]){const suffix=Number(match[2]);start=Math.max(0,stat.size-suffix);end=stat.size-1;}
    if(start<0||end<start||start>=stat.size)return reply.code(416).header('Content-Range',`bytes */${stat.size}`).send();
    end=Math.min(end,stat.size-1);
    reply.code(206).header('Content-Range',`bytes ${start}-${end}/${stat.size}`).header('Content-Length',String(end-start+1));
    return reply.send(streamLocalAsset(app.config,asset.storage_key,{start,end}));
  }
  reply.header('Content-Length',String(stat.size));
  return reply.send(streamLocalAsset(app.config,asset.storage_key));
}

export async function digitalDeliveryRoutes(app){
  app.get('/v1/merchant/catalog/product-policies',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_READ)]},async()=>({data:{product_types:[
    {...productFulfillmentPolicy('PHYSICAL'),description:'Shippable goods, packaged products and merchandise.'},
    {...productFulfillmentPolicy('FOOD'),description:'Prepared meals, drinks and fresh local orders.'},
    {...productFulfillmentPolicy('DIGITAL_IMAGE'),description:'Purchased images delivered through the secure customer library.'},
    {...productFulfillmentPolicy('DIGITAL_VIDEO'),description:'Purchased video delivered through the secure customer library.'},
    {...productFulfillmentPolicy('SERVICE'),description:'Appointments or services without product delivery.'},
  ],digital_access_modes:[
    {value:'VIEW_ONLY',label:'View in secure library only',fulfillment_mode:'DIGITAL_ACCESS'},
    {value:'DOWNLOAD_ONLY',label:'Download only',fulfillment_mode:'DIGITAL_DOWNLOAD'},
    {value:'VIEW_AND_DOWNLOAD',label:'View in library + allow download',fulfillment_mode:'DIGITAL_ACCESS'},
  ]}}));

  app.get('/v1/merchant/products/:productId/digital-policy',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_READ)]},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const product=await resolveProduct(app.db,request.auth.tenantId,store.id,request.params.productId);
    if(!isDigitalProductType(product.product_type))throw errors.badRequest('DIGITAL_POLICY_NOT_APPLICABLE','Digital access policy is only available for digital image/video products');
    const row=await app.db.query(`SELECT access_mode,download_limit,updated_at FROM product_digital_policies WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3`,[request.auth.tenantId,store.id,product.id]);
    return {data:{product:{id:product.public_id,type:product.product_type},policy:row.rows[0]||{access_mode:'VIEW_ONLY',download_limit:null,updated_at:null}}};
  });

  app.put('/v1/merchant/products/:productId/digital-policy',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema:{body:{type:'object',additionalProperties:false,required:['access_mode'],properties:{access_mode:{type:'string',enum:ACCESS_MODES},download_limit:{anyOf:[{type:'integer',minimum:0,maximum:100000},{type:'null'}]}}}},
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const policy=await app.db.transaction(async client=>{
      const product=await resolveProduct(client,request.auth.tenantId,store.id,request.params.productId,{forUpdate:true});
      if(!isDigitalProductType(product.product_type))throw errors.badRequest('DIGITAL_POLICY_NOT_APPLICABLE','Digital access policy is only available for digital image/video products');
      const accessMode=request.body.access_mode;const deliveryMode=accessMode==='DOWNLOAD_ONLY'?'DIGITAL_DOWNLOAD':'DIGITAL_ACCESS';
      const saved=await client.query(`INSERT INTO product_digital_policies(tenant_id,store_id,product_id,access_mode,download_limit,updated_at)
        VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT (tenant_id,store_id,product_id) DO UPDATE SET access_mode=EXCLUDED.access_mode,download_limit=EXCLUDED.download_limit,updated_at=now()
        RETURNING access_mode,download_limit,updated_at`,[request.auth.tenantId,store.id,product.id,accessMode,request.body.download_limit??null]);
      await client.query('DELETE FROM product_fulfillment_modes WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3',[request.auth.tenantId,store.id,product.id]);
      await client.query('INSERT INTO product_fulfillment_modes(tenant_id,store_id,product_id,mode) VALUES($1,$2,$3,$4)',[request.auth.tenantId,store.id,product.id,deliveryMode]);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'catalog.digital_policy.update',targetType:'product',targetId:product.id,metadata:{product_id:product.public_id,access_mode:accessMode,download_limit:request.body.download_limit??null,fulfillment_mode:deliveryMode},requestIp:request.ip,requestId:request.id});
      return saved.rows[0];
    });
    return {data:{policy}};
  });

  app.get('/v1/customer/library',{preHandler:[app.requireCustomerAuth]},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request));
    const items=await customerDigitalLibrary(app.db,{tenantId:request.auth.tenantId,storeId:store.id,customerId:request.auth.actorId});
    return {data:{library:items}};
  });

  app.post('/v1/customer/library/:entitlementId/assets/:assetId/access',{
    preHandler:[app.requireCustomerAuth],schema:{body:{type:'object',additionalProperties:false,required:['mode'],properties:{mode:{type:'string',enum:['VIEW','DOWNLOAD']}}}},
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request));
    const access=await app.db.transaction(client=>authorizeDigitalAssetAccess(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:request.auth.actorId,entitlementRef:request.params.entitlementId,assetRef:request.params.assetId,mode:request.body.mode,requestId:request.id}));
    const ttl=request.body.mode==='VIEW'?900:300;
    const token=createDigitalContentToken(app.config.jwtAccessSecret,{entitlementId:access.entitlement_id,assetId:access.asset_id,mode:access.mode,ttlSeconds:ttl});
    return {data:{access:{...access,expires_in:ttl,content_path:`/v1/digital/content/${encodeURIComponent(access.entitlement_id)}/${encodeURIComponent(access.asset_id)}?token=${encodeURIComponent(token)}`}}};
  });

  app.get('/v1/digital/content/:entitlementId/:assetId',{schema:{querystring:{type:'object',additionalProperties:false,required:['token'],properties:{token:{type:'string',minLength:20,maxLength:4096}}}}},async(request,reply)=>{
    const token=verifyDigitalContentToken(app.config.jwtAccessSecret,request.query.token,{entitlementId:request.params.entitlementId,assetId:request.params.assetId});
    const asset=await resolveSignedDigitalContent(app.db,{entitlementRef:request.params.entitlementId,assetRef:request.params.assetId,mode:token.m});
    return sendProtectedAsset(app,request,reply,asset,token.m);
  });
}
