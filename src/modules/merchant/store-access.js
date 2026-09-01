import { errors } from '../../core/errors.js';

export const STORE_ACCESS_MODES=Object.freeze({ALL:'ALL_STORES',ASSIGNED:'ASSIGNED_STORES'});

export function normalizeStoreAccessMode(value){
 const mode=String(value||STORE_ACCESS_MODES.ALL).trim().toUpperCase();
 if(!Object.values(STORE_ACCESS_MODES).includes(mode))throw errors.badRequest('STAFF_STORE_ACCESS_MODE_INVALID','Store access mode must be ALL_STORES or ASSIGNED_STORES');
 return mode;
}

export async function loadEffectiveStoreScope(db,{tenantId,userId,roleKeys=[],storedMode=null}){
 let mode=storedMode;
 if(!mode){
  const row=await db.query('SELECT store_access_mode FROM merchant_users WHERE tenant_id=$1 AND id=$2',[tenantId,userId]);
  if(!row.rowCount)throw errors.unauthorized('SESSION_INVALID','Merchant account is no longer available');
  mode=row.rows[0].store_access_mode;
 }
 const owner=roleKeys.includes('OWNER');
 mode=owner?STORE_ACCESS_MODES.ALL:normalizeStoreAccessMode(mode);
 const rows=mode===STORE_ACCESS_MODES.ALL
  ?await db.query(`SELECT s.public_id AS id,s.slug,s.name,s.status,s.is_primary
      FROM stores s WHERE s.tenant_id=$1
      ORDER BY (s.status='ACTIVE') DESC,s.is_primary DESC,s.created_at,s.id`,[tenantId])
  :await db.query(`SELECT s.public_id AS id,s.slug,s.name,s.status,s.is_primary
      FROM merchant_user_store_access a
      JOIN stores s ON s.id=a.store_id AND s.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1 AND a.merchant_user_id=$2
      ORDER BY (s.status='ACTIVE') DESC,s.is_primary DESC,s.created_at,s.id`,[tenantId,userId]);
 const stores=rows.rows;
 const defaultStore=stores.find(store=>store.status==='ACTIVE'&&store.is_primary)
  ||stores.find(store=>store.status==='ACTIVE')||stores[0]||null;
 return {mode,stores,default_store_id:defaultStore?.id||null};
}

export async function enforceMerchantStoreScope(db,request,auth){
 const scope=await loadEffectiveStoreScope(db,{tenantId:auth.tenantId,userId:auth.actorId,roleKeys:auth.roleKeys,storedMode:auth.profile.store_access_mode});
 auth.storeAccess=scope;
 if(scope.mode!==STORE_ACCESS_MODES.ASSIGNED)return scope;
 const requested=String(request.headers['x-store-id']||'').trim();
 if(requested){
  if(!scope.stores.some(store=>store.id===requested))throw errors.forbidden('STAFF_STORE_ACCESS_REQUIRED','This staff account is not assigned to the requested store');
  return scope;
 }
 // Prevent existing store resolvers from silently falling back to an unassigned
 // primary store. Tenant-wide routes ignore this header, while store-scoped routes
 // resolve only an authorized store (or a guaranteed non-existent sentinel).
 request.headers['x-store-id']=scope.default_store_id||'__no_authorized_store__';
 return scope;
}

export async function updateStaffStoreScope(client,{tenantId,userId,actorId,mode,storePublicIds=[]}){
 const normalized=normalizeStoreAccessMode(mode);
 const roleRows=await client.query(`SELECT r.key FROM merchant_user_roles ur JOIN merchant_roles r ON r.id=ur.role_id AND r.tenant_id=ur.tenant_id WHERE ur.tenant_id=$1 AND ur.merchant_user_id=$2`,[tenantId,userId]);
 const roleKeys=roleRows.rows.map(row=>row.key);
 if(roleKeys.includes('OWNER')&&normalized!==STORE_ACCESS_MODES.ALL)throw errors.conflict('OWNER_STORE_SCOPE_PROTECTED','OWNER accounts must retain access to all tenant stores');
 const refs=[...new Set(storePublicIds.map(value=>String(value||'').trim()).filter(Boolean))];
 let stores=[];
 if(normalized===STORE_ACCESS_MODES.ASSIGNED){
  if(!refs.length)throw errors.badRequest('STAFF_STORE_ASSIGNMENT_REQUIRED','Assigned-store access requires at least one store');
  const found=await client.query(`SELECT id,public_id,status FROM stores WHERE tenant_id=$1 AND public_id=ANY($2::text[]) ORDER BY public_id`,[tenantId,refs]);
  if(found.rowCount!==refs.length)throw errors.badRequest('STAFF_STORE_INVALID','One or more assigned stores do not belong to this tenant');
  stores=found.rows;
 }
 await client.query('UPDATE merchant_users SET store_access_mode=$1,updated_at=now() WHERE tenant_id=$2 AND id=$3',[normalized,tenantId,userId]);
 await client.query('DELETE FROM merchant_user_store_access WHERE tenant_id=$1 AND merchant_user_id=$2',[tenantId,userId]);
 for(const store of stores)await client.query(`INSERT INTO merchant_user_store_access(tenant_id,merchant_user_id,store_id,created_by) VALUES($1,$2,$3,$4)`,[tenantId,userId,store.id,actorId]);
 return loadEffectiveStoreScope(client,{tenantId,userId,roleKeys,storedMode:normalized});
}
