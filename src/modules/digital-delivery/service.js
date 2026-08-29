import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';

const DIGITAL_TYPES=new Set(['DIGITAL_IMAGE','DIGITAL_VIDEO']);
const ACCESS_MODES=new Set(['VIEW_ONLY','DOWNLOAD_ONLY','VIEW_AND_DOWNLOAD']);
const TOKEN_MODES=new Set(['VIEW','DOWNLOAD']);
const revokedOrderStatuses=new Set(['CANCELLED','REFUND_PENDING','REFUNDED']);

const defaultAccessMode=(fulfillmentMode)=>fulfillmentMode==='DIGITAL_DOWNLOAD'?'DOWNLOAD_ONLY':'VIEW_ONLY';
const canView=(mode)=>mode==='VIEW_ONLY'||mode==='VIEW_AND_DOWNLOAD';
const canDownload=(mode)=>mode==='DOWNLOAD_ONLY'||mode==='VIEW_AND_DOWNLOAD';

export async function prepareOrderDigitalEntitlements(client,{tenantId,storeId,orderId}){
  const items=await client.query(`SELECT oi.id AS order_item_id,oi.product_id,oi.variant_id,oi.fulfillment_mode,oi.product_type_snapshot,
      o.customer_id,pdp.access_mode,pdp.download_limit
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id AND o.tenant_id=oi.tenant_id AND o.store_id=oi.store_id
    LEFT JOIN product_digital_policies pdp ON pdp.tenant_id=oi.tenant_id AND pdp.store_id=oi.store_id AND pdp.product_id=oi.product_id
    WHERE oi.tenant_id=$1 AND oi.store_id=$2 AND oi.order_id=$3
      AND oi.product_type_snapshot IN ('DIGITAL_IMAGE','DIGITAL_VIDEO')`,[tenantId,storeId,orderId]);
  const created=[];
  for(const item of items.rows){
    const accessMode=ACCESS_MODES.has(item.access_mode)?item.access_mode:defaultAccessMode(item.fulfillment_mode);
    const inserted=await client.query(`INSERT INTO order_digital_entitlements(
        id,public_id,tenant_id,store_id,order_id,order_item_id,customer_id,product_id,access_mode,status,download_limit)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10)
      ON CONFLICT (tenant_id,store_id,order_item_id) DO NOTHING RETURNING id,public_id`,[
      uuid(),publicId('dent'),tenantId,storeId,orderId,item.order_item_id,item.customer_id,item.product_id,accessMode,item.download_limit??null,
    ]);
    let entitlement=inserted.rows[0];
    if(!entitlement){
      const existing=await client.query(`SELECT id,public_id FROM order_digital_entitlements
        WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3`,[tenantId,storeId,item.order_item_id]);
      entitlement=existing.rows[0];
    }
    if(!entitlement)continue;
    await client.query(`INSERT INTO order_digital_entitlement_assets(tenant_id,store_id,entitlement_id,asset_id,sort_order)
      SELECT $1,$2,$3,m.asset_id,m.sort_order
        FROM product_media m
        JOIN media_assets a ON a.id=m.asset_id AND a.tenant_id=m.tenant_id AND a.store_id=m.store_id
       WHERE m.tenant_id=$1 AND m.store_id=$2 AND m.product_id=$4
         AND m.visibility='PRIVATE' AND m.status='ACTIVE' AND m.asset_id IS NOT NULL AND a.status='ACTIVE'
         AND (m.variant_id IS NULL OR m.variant_id IS NOT DISTINCT FROM $5::uuid)
      ON CONFLICT DO NOTHING`,[tenantId,storeId,entitlement.id,item.product_id,item.variant_id]);
    if(inserted.rowCount)created.push(entitlement.public_id);
  }
  return created;
}

export async function syncCustomerDigitalEntitlements(client,{tenantId,storeId,customerId}){
  await client.query(`UPDATE order_digital_entitlements e SET status='REVOKED',revoked_at=COALESCE(revoked_at,now()),updated_at=now()
    FROM orders o WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.customer_id=$3 AND o.id=e.order_id
      AND o.tenant_id=e.tenant_id AND o.store_id=e.store_id AND o.status IN ('CANCELLED','REFUND_PENDING','REFUNDED')
      AND e.status<>'REVOKED'`,[tenantId,storeId,customerId]);
  await client.query(`UPDATE order_digital_entitlements e SET status='ACTIVE',granted_at=COALESCE(granted_at,now()),revoked_at=NULL,updated_at=now()
    FROM orders o WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.customer_id=$3 AND o.id=e.order_id
      AND o.tenant_id=e.tenant_id AND o.store_id=e.store_id AND o.payment_status='PAID'
      AND o.status NOT IN ('CANCELLED','REFUND_PENDING','REFUNDED') AND e.status='PENDING'`,[tenantId,storeId,customerId]);
}

export async function customerDigitalLibrary(db,{tenantId,storeId,customerId}){
  await db.transaction(client=>syncCustomerDigitalEntitlements(client,{tenantId,storeId,customerId}));
  const rows=await db.query(`SELECT e.id AS internal_id,e.public_id AS id,e.access_mode,e.status,e.download_limit,e.download_count,e.granted_at,e.created_at,
      o.public_id AS order_id,o.order_number,o.payment_status,o.status AS order_status,o.created_at AS purchased_at,
      oi.public_id AS order_item_id,oi.quantity,oi.title_snapshot,oi.variant_title_snapshot,oi.product_type_snapshot,
      p.public_id AS product_id,p.slug AS product_slug,p.name AS product_name
    FROM order_digital_entitlements e
    JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id AND o.store_id=e.store_id
    JOIN order_items oi ON oi.id=e.order_item_id AND oi.tenant_id=e.tenant_id AND oi.store_id=e.store_id
    JOIN products p ON p.id=e.product_id AND p.tenant_id=e.tenant_id AND p.store_id=e.store_id
    WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.customer_id=$3 AND e.status IN ('PENDING','ACTIVE')
    ORDER BY o.created_at DESC,e.created_at DESC`,[tenantId,storeId,customerId]);
  const library=[];
  for(const row of rows.rows){
    const assets=await db.query(`SELECT a.public_id AS id,a.media_type,a.mime_type,a.original_filename,a.file_size,ea.sort_order
      FROM order_digital_entitlement_assets ea
      JOIN media_assets a ON a.id=ea.asset_id
      WHERE ea.tenant_id=$1 AND ea.store_id=$2 AND ea.entitlement_id=$3 AND a.visibility='PRIVATE' AND a.status='ACTIVE'
      ORDER BY ea.sort_order,a.created_at,a.id`,[tenantId,storeId,row.internal_id]);
    const {internal_id,...safe}=row;
    library.push({...safe,can_view:row.status==='ACTIVE'&&canView(row.access_mode),can_download:row.status==='ACTIVE'&&canDownload(row.access_mode),assets:assets.rows});
  }
  return library;
}

export async function authorizeDigitalAssetAccess(client,{tenantId,storeId,customerId,entitlementRef,assetRef,mode,requestId}){
  if(!TOKEN_MODES.has(mode))throw errors.badRequest('DIGITAL_ACCESS_MODE_INVALID','Access mode must be VIEW or DOWNLOAD');
  await syncCustomerDigitalEntitlements(client,{tenantId,storeId,customerId});
  const found=await client.query(`SELECT e.*,o.payment_status,o.status AS order_status,a.public_id AS asset_public_id,a.id AS asset_internal_id,
      a.media_type,a.mime_type,a.original_filename,a.file_size
    FROM order_digital_entitlements e
    JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id AND o.store_id=e.store_id
    JOIN order_digital_entitlement_assets ea ON ea.tenant_id=e.tenant_id AND ea.store_id=e.store_id AND ea.entitlement_id=e.id
    JOIN media_assets a ON a.id=ea.asset_id AND a.visibility='PRIVATE' AND a.status='ACTIVE'
    WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.customer_id=$3 AND e.public_id=$4 AND a.public_id=$5
    FOR UPDATE OF e`,[tenantId,storeId,customerId,entitlementRef,assetRef]);
  if(!found.rowCount)throw errors.notFound('DIGITAL_CONTENT_NOT_FOUND','Purchased digital content not found');
  const row=found.rows[0];
  if(row.status!=='ACTIVE'||row.payment_status!=='PAID'||revokedOrderStatuses.has(row.order_status))throw errors.forbidden('DIGITAL_ACCESS_NOT_ACTIVE','Digital access is not active for this order');
  if(mode==='VIEW'&&!canView(row.access_mode))throw errors.forbidden('DIGITAL_VIEW_NOT_ALLOWED','This purchase does not include gallery access');
  if(mode==='DOWNLOAD'&&!canDownload(row.access_mode))throw errors.forbidden('DIGITAL_DOWNLOAD_NOT_ALLOWED','Downloads are disabled for this purchase');
  if(mode==='DOWNLOAD'&&row.download_limit!==null&&Number(row.download_count)>=Number(row.download_limit))throw errors.forbidden('DIGITAL_DOWNLOAD_LIMIT_REACHED','Download limit reached');
  if(mode==='DOWNLOAD')await client.query(`UPDATE order_digital_entitlements SET download_count=download_count+1,updated_at=now() WHERE id=$1`,[row.id]);
  await client.query(`INSERT INTO digital_access_events(tenant_id,store_id,entitlement_id,customer_id,asset_id,event_type,request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[tenantId,storeId,row.id,customerId,row.asset_internal_id,mode,requestId||null]);
  return {entitlement_id:row.public_id,asset_id:row.asset_public_id,mode,media_type:row.media_type,mime_type:row.mime_type,original_filename:row.original_filename,file_size:Number(row.file_size)};
}

const sign=(secret,value)=>createHmac('sha256',secret).update(value).digest('base64url');
export function createDigitalContentToken(secret,{entitlementId,assetId,mode,ttlSeconds=900}){
  const payload={v:1,e:entitlementId,a:assetId,m:mode,exp:Math.floor(Date.now()/1000)+ttlSeconds,n:randomBytes(8).toString('hex')};
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(secret,encoded)}`;
}

export function verifyDigitalContentToken(secret,token,{entitlementId,assetId}){
  const [encoded,signature,extra]=String(token||'').split('.');
  if(!encoded||!signature||extra)throw errors.forbidden('DIGITAL_TOKEN_INVALID','Digital content link is invalid');
  const expected=Buffer.from(sign(secret,encoded));const received=Buffer.from(signature);
  if(expected.length!==received.length||!timingSafeEqual(expected,received))throw errors.forbidden('DIGITAL_TOKEN_INVALID','Digital content link is invalid');
  let payload;try{payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{throw errors.forbidden('DIGITAL_TOKEN_INVALID','Digital content link is invalid');}
  if(payload?.v!==1||payload.e!==entitlementId||payload.a!==assetId||!TOKEN_MODES.has(payload.m)||!Number.isFinite(payload.exp)||payload.exp<Math.floor(Date.now()/1000))throw errors.forbidden('DIGITAL_TOKEN_EXPIRED','Digital content link has expired');
  return payload;
}

export async function resolveSignedDigitalContent(db,{entitlementRef,assetRef,mode}){
  const found=await db.query(`SELECT e.public_id AS entitlement_id,e.status AS entitlement_status,e.access_mode,o.payment_status,o.status AS order_status,
      a.id,a.public_id,a.tenant_id,a.store_id,a.storage_provider,a.storage_key,a.visibility,a.media_type,a.mime_type,a.original_filename,a.file_size,a.sha256,a.url,a.status AS asset_status
    FROM order_digital_entitlements e
    JOIN orders o ON o.id=e.order_id AND o.tenant_id=e.tenant_id AND o.store_id=e.store_id
    JOIN order_digital_entitlement_assets ea ON ea.tenant_id=e.tenant_id AND ea.store_id=e.store_id AND ea.entitlement_id=e.id
    JOIN media_assets a ON a.id=ea.asset_id
    WHERE e.public_id=$1 AND a.public_id=$2 AND a.visibility='PRIVATE' AND a.status='ACTIVE' LIMIT 1`,[entitlementRef,assetRef]);
  if(!found.rowCount)throw errors.notFound('DIGITAL_CONTENT_NOT_FOUND','Digital content not found');
  const row=found.rows[0];
  if(row.entitlement_status!=='ACTIVE'||row.asset_status!=='ACTIVE'||row.payment_status!=='PAID'||revokedOrderStatuses.has(row.order_status))throw errors.forbidden('DIGITAL_ACCESS_NOT_ACTIVE','Digital access is no longer active');
  if(mode==='VIEW'&&!canView(row.access_mode))throw errors.forbidden('DIGITAL_VIEW_NOT_ALLOWED','Gallery access is disabled');
  if(mode==='DOWNLOAD'&&!canDownload(row.access_mode))throw errors.forbidden('DIGITAL_DOWNLOAD_NOT_ALLOWED','Downloads are disabled');
  return row;
}

export function isDigitalType(value){return DIGITAL_TYPES.has(value);}
