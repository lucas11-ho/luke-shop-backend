import { createHash } from 'node:crypto';
import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { allowedMime, extensionForMime, deleteAsset, fetchR2Asset, hasExpectedSignature, mediaTypeForMime, safeOriginalFilename, statLocalAsset, storagePublicUrl, streamLocalAsset, writeAsset } from './storage.js';

const storeHeader=(request)=>request.headers['x-store-id']||null;
const uploadTypes=['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm'];
const cleanMime=(value)=>String(value||'').split(';')[0].trim().toLowerCase();

async function resolveAsset(db, tenantId, storeId, ref, {activeOnly=true}={}) {
  const r=await db.query(`SELECT * FROM media_assets WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3${activeOnly?" AND status='ACTIVE'":''}`,[tenantId,storeId,ref]);
  if(!r.rowCount) throw errors.notFound('ASSET_NOT_FOUND','Media asset not found'); return r.rows[0];
}

async function sendAsset(app, request, reply, asset) {
  reply.header('Accept-Ranges','bytes').header('Cache-Control',asset.visibility==='PUBLIC'?'public, max-age=3600':'private, no-store').header('Cross-Origin-Resource-Policy','cross-origin').type(asset.mime_type);
  const range=request.headers.range||'';
  if(asset.storage_provider==='R2'){
    const remote=await fetchR2Asset(app.config,asset.storage_key,{range}).catch(()=>null);if(!remote)throw errors.notFound('ASSET_CONTENT_NOT_FOUND','Asset content not found');
    if(remote.status===206){reply.code(206);if(remote.contentRange)reply.header('Content-Range',remote.contentRange);}
    if(remote.size)reply.header('Content-Length',String(remote.size));return reply.send(remote.body);
  }
  if(asset.storage_provider!=='LOCAL') throw errors.unavailable('ASSET_STORAGE_UNAVAILABLE','Asset storage provider is unavailable');
  const s=await statLocalAsset(app.config,asset.storage_key).catch(()=>null); if(!s) throw errors.notFound('ASSET_CONTENT_NOT_FOUND','Asset content not found');
  if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m)return reply.code(416).header('Content-Range',`bytes */${s.size}`).send();let start=m[1]?Number(m[1]):0;let end=m[2]?Number(m[2]):s.size-1;if(!m[1]&&m[2]){const suffix=Number(m[2]);start=Math.max(0,s.size-suffix);end=s.size-1;}if(start<0||end<start||start>=s.size)return reply.code(416).header('Content-Range',`bytes */${s.size}`).send();end=Math.min(end,s.size-1);reply.code(206).header('Content-Range',`bytes ${start}-${end}/${s.size}`).header('Content-Length',String(end-start+1));return reply.send(streamLocalAsset(app.config,asset.storage_key,{start,end}));}
  reply.header('Content-Length',String(s.size)); return reply.send(streamLocalAsset(app.config,asset.storage_key));
}

export async function merchantAssetRoutes(app) {
  for(const mime of uploadTypes) if(!app.hasContentTypeParser(mime)) app.addContentTypeParser(mime,{parseAs:'buffer',bodyLimit:app.config.assetVideoMaxBytes},(_req,body,done)=>done(null,body));

  app.post('/v1/merchant/assets/upload',{bodyLimit:app.config.assetVideoMaxBytes,preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_WRITE)],schema:{querystring:{type:'object',additionalProperties:false,required:['filename'],properties:{filename:{type:'string',minLength:1,maxLength:240},visibility:{type:'string',enum:['PUBLIC','PRIVATE'],default:'PUBLIC'}}}}},async(request,reply)=>{
    const mime=cleanMime(request.headers['content-type']); if(!allowedMime(mime)) throw errors.badRequest('ASSET_MEDIA_TYPE_UNSUPPORTED','Use JPEG, PNG, WEBP, GIF, MP4, or WEBM');
    if(!Buffer.isBuffer(request.body)||!request.body.length) throw errors.badRequest('ASSET_FILE_REQUIRED','Upload body is empty');
    const mediaType=mediaTypeForMime(mime); const limit=mediaType==='IMAGE'?app.config.assetImageMaxBytes:app.config.assetVideoMaxBytes; if(request.body.length>limit) throw errors.badRequest('ASSET_FILE_TOO_LARGE',`${mediaType==='IMAGE'?'Image':'Video'} exceeds configured upload limit`);
    if(!hasExpectedSignature(request.body,mime)) throw errors.badRequest('ASSET_SIGNATURE_INVALID','Uploaded bytes do not match the declared media type');
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false}); const publicID=publicId('ast'); const ext=extensionForMime(mime); const storageKey=`${request.auth.tenantId}/${store.id}/${publicID}${ext}`; const visibility=request.query.visibility||'PUBLIC'; const provider=app.config.assetStorageDriver; const url=visibility==='PUBLIC'?storagePublicUrl(app.config,storageKey,publicID):null; const digest=createHash('sha256').update(request.body).digest('hex');
    await writeAsset(app.config,storageKey,request.body,mime);
    let row;
    try {
      row=await app.db.transaction(async(client)=>{const id=uuid();const r=await client.query(`INSERT INTO media_assets(id,public_id,tenant_id,store_id,storage_provider,storage_key,visibility,media_type,mime_type,original_filename,file_size,sha256,url,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING public_id,visibility,media_type,mime_type,original_filename,file_size,sha256,url,status,created_at`,[id,publicID,request.auth.tenantId,store.id,provider,storageKey,visibility,mediaType,mime,safeOriginalFilename(request.query.filename),request.body.length,digest,url,request.auth.actorId]);await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'assets.upload',targetType:'media_asset',targetId:id,metadata:{public_id:publicID,media_type:mediaType,visibility,mime_type:mime,file_size:request.body.length,storage_provider:provider},requestIp:request.ip,requestId:request.id});return r.rows[0];});
    } catch (error) {
      try { await deleteAsset(app.config,storageKey); } catch (cleanupError) { app.log.error({err:cleanupError,request_id:request.id,storage_key:storageKey,storage_provider:provider},'asset rollback cleanup failed'); }
      throw error;
    }
    return reply.code(201).send({data:{asset:row}});
  });

  app.get('/v1/merchant/assets',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_READ)],schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',maxLength:200},media_type:{type:'string',enum:['IMAGE','VIDEO']},visibility:{type:'string',enum:['PUBLIC','PRIVATE']},status:{type:'string',enum:['ACTIVE','INACTIVE'],default:'ACTIVE'},limit:{type:'integer',minimum:1,maximum:200,default:60}}}}},async(request)=>{const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});const vals=[request.auth.tenantId,store.id];let where='a.tenant_id=$1 AND a.store_id=$2';for(const [key,col] of [['media_type','a.media_type'],['visibility','a.visibility'],['status','a.status']])if(request.query[key]){vals.push(request.query[key]);where+=` AND ${col}=$${vals.length}`;}if(request.query.q){vals.push(`%${request.query.q}%`);where+=` AND (a.original_filename ILIKE $${vals.length} OR a.public_id ILIKE $${vals.length})`;}vals.push(request.query.limit||60);const r=await app.db.query(`SELECT a.public_id,a.visibility,a.media_type,a.mime_type,a.original_filename,a.file_size,a.sha256,a.url,a.status,a.created_at,COUNT(pm.id)::int AS usage_count FROM media_assets a LEFT JOIN product_media pm ON pm.asset_id=a.id AND pm.tenant_id=a.tenant_id AND pm.store_id=a.store_id AND pm.status='ACTIVE' WHERE ${where} GROUP BY a.id ORDER BY a.created_at DESC LIMIT $${vals.length}`,vals);return{data:{assets:r.rows,store:{id:store.public_id,name:store.name}}};});

  app.get('/v1/merchant/assets/:assetId/content',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_READ)]},async(request,reply)=>{const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});const asset=await resolveAsset(app.db,request.auth.tenantId,store.id,request.params.assetId);return sendAsset(app,request,reply,asset);});

  app.delete('/v1/merchant/assets/:assetId',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_WRITE)]},async(request)=>{const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});await app.db.transaction(async(client)=>{const asset=await resolveAsset(client,request.auth.tenantId,store.id,request.params.assetId);await client.query("UPDATE media_assets SET status='INACTIVE',updated_at=now() WHERE id=$1",[asset.id]);await client.query("UPDATE product_media SET status='INACTIVE',is_primary=false,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND asset_id=$3",[request.auth.tenantId,store.id,asset.id]);await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'assets.deactivate',targetType:'media_asset',targetId:asset.id,metadata:{public_id:asset.public_id},requestIp:request.ip,requestId:request.id});});return{data:{deactivated:true}};});
}

export async function publicAssetRoutes(app){
  app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cross-Origin-Resource-Policy','cross-origin');return payload;});
  app.get('/v1/assets/public/:assetId',async(request,reply)=>{const r=await app.db.query("SELECT * FROM media_assets WHERE public_id=$1 AND visibility='PUBLIC' AND status='ACTIVE' LIMIT 1",[request.params.assetId]);if(!r.rowCount)throw errors.notFound('ASSET_NOT_FOUND','Media asset not found');return sendAsset(app,request,reply,r.rows[0]);});
}
