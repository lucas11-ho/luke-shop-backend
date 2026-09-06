import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { publicId } from '../../core/identifiers.js';
import { writeAudit } from '../../core/audit.js';
import { publicPlatformIconReference, validatePlatformIconReference } from '../icons/reference-policy.js';
import { resolveStore } from '../catalog/service.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const DESTINATIONS=new Set(['HOME','EXPLORE','CART','ORDERS','PROFILE']);
const iconKeySchema={anyOf:[{type:'string',minLength:3,maxLength:80},{type:'null'}]};
const bodyProperties={
  title:{type:'string',minLength:1,maxLength:80},
  destination:{type:'string',enum:[...DESTINATIONS]},
  icon_key:iconKeySchema,
  status:{type:'string',enum:['ACTIVE','INACTIVE']},
  sort_order:{type:'integer',minimum:0,maximum:10000},
};
const has=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
const normalizeTitle=value=>{
  const title=String(value||'').trim();
  if(!title||title.length>80)throw errors.badRequest('MENU_SHORTCUT_TITLE_INVALID','Menu shortcut title must be 1-80 characters');
  return title;
};
const normalizeDestination=value=>{
  const destination=String(value||'').trim().toUpperCase();
  if(!DESTINATIONS.has(destination))throw errors.badRequest('MENU_SHORTCUT_DESTINATION_INVALID','Menu shortcut destination is not supported');
  return destination;
};
const selectSql=`SELECT s.id,s.public_id,s.title,s.destination,s.icon_key,s.status,s.sort_order,s.created_at,s.updated_at,
  i.source_type AS icon_source_type,i.library_pack AS icon_library_pack,i.library_icon AS icon_library_icon,i.color_mode AS icon_color_mode,
  EXISTS(SELECT 1 FROM platform_icon_assets al WHERE al.icon_id=i.id AND al.variant='LIGHT') AS icon_has_light_asset,
  EXISTS(SELECT 1 FROM platform_icon_assets ad WHERE ad.icon_id=i.id AND ad.variant='DARK') AS icon_has_dark_asset
  FROM storefront_menu_shortcuts s LEFT JOIN platform_icons i ON i.key=s.icon_key`;
const merchantRow=row=>({
  id:row.public_id,title:row.title,destination:row.destination,icon_key:row.icon_key||null,status:row.status,sort_order:Number(row.sort_order||0),
  icon:publicPlatformIconReference(row),created_at:row.created_at,updated_at:row.updated_at,
});
const storefrontRow=row=>({
  id:row.public_id,title:row.title,destination:row.destination,sort_order:Number(row.sort_order||0),icon:publicPlatformIconReference(row),
});

export async function menuShortcutRoutes(app){
  app.get('/v1/merchant/menu-shortcuts',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_READ)],
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const result=await app.db.query(`${selectSql} WHERE s.tenant_id=$1 AND s.store_id=$2 ORDER BY s.sort_order,s.created_at,s.public_id`,[request.auth.tenantId,store.id]);
    return {data:{store:{id:store.public_id,name:store.name},menu_shortcuts:result.rows.map(merchantRow)}};
  });

  app.post('/v1/merchant/menu-shortcuts',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_MANAGE)],
    schema:{body:{type:'object',additionalProperties:false,required:['title','destination'],properties:bodyProperties}},
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const created=await app.db.transaction(async client=>{
      const title=normalizeTitle(request.body.title);
      const destination=normalizeDestination(request.body.destination);
      const iconKey=await validatePlatformIconReference(client,request.body.icon_key,{scope:'MENU',errorCode:'MENU_ICON_NOT_ALLOWED'});
      const status=request.body.status||'ACTIVE';
      const sortOrder=request.body.sort_order??0;
      const result=await client.query(
        `INSERT INTO storefront_menu_shortcuts(public_id,tenant_id,store_id,title,destination,icon_key,status,sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,public_id`,
        [publicId('menu'),request.auth.tenantId,store.id,title,destination,iconKey,status,sortOrder],
      );
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,
        action:'storefront.menu_shortcut.create',targetType:'storefront_menu_shortcut',targetId:result.rows[0].id,
        metadata:{public_id:result.rows[0].public_id,title,destination,icon_key:iconKey,status,sort_order:sortOrder},requestIp:request.ip,requestId:request.id});
      const row=await client.query(`${selectSql} WHERE s.id=$1`,[result.rows[0].id]);
      return merchantRow(row.rows[0]);
    });
    return {data:{menu_shortcut:created}};
  });

  app.patch('/v1/merchant/menu-shortcuts/:shortcutId',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_MANAGE)],
    schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:bodyProperties}},
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const updated=await app.db.transaction(async client=>{
      const found=await client.query(
        'SELECT id,public_id,title,destination,icon_key,status,sort_order FROM storefront_menu_shortcuts WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 FOR UPDATE',
        [request.auth.tenantId,store.id,request.params.shortcutId],
      );
      if(!found.rowCount)throw errors.notFound('MENU_SHORTCUT_NOT_FOUND','Menu shortcut not found');
      const current=found.rows[0];
      const title=has(request.body,'title')?normalizeTitle(request.body.title):current.title;
      const destination=has(request.body,'destination')?normalizeDestination(request.body.destination):current.destination;
      const status=has(request.body,'status')?request.body.status:current.status;
      const sortOrder=has(request.body,'sort_order')?request.body.sort_order:current.sort_order;
      let iconKey=current.icon_key||null;
      if(has(request.body,'icon_key')){
        const requested=request.body.icon_key==null||String(request.body.icon_key).trim()===''?null:String(request.body.icon_key).trim().toUpperCase();
        if(requested!==iconKey){
          iconKey=await validatePlatformIconReference(client,requested,{scope:'MENU',errorCode:'MENU_ICON_NOT_ALLOWED'});
        }
      }
      await client.query(
        `UPDATE storefront_menu_shortcuts SET title=$1,destination=$2,icon_key=$3,status=$4,sort_order=$5,updated_at=now() WHERE id=$6`,
        [title,destination,iconKey,status,sortOrder,current.id],
      );
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,
        action:'storefront.menu_shortcut.update',targetType:'storefront_menu_shortcut',targetId:current.id,
        metadata:{public_id:current.public_id,previous:{title:current.title,destination:current.destination,icon_key:current.icon_key||null,status:current.status,sort_order:current.sort_order},next:{title,destination,icon_key:iconKey,status,sort_order:sortOrder}},requestIp:request.ip,requestId:request.id});
      const row=await client.query(`${selectSql} WHERE s.id=$1`,[current.id]);
      return merchantRow(row.rows[0]);
    });
    return {data:{menu_shortcut:updated}};
  });

  app.delete('/v1/merchant/menu-shortcuts/:shortcutId',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_MANAGE)],
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const deleted=await app.db.transaction(async client=>{
      const found=await client.query(
        'SELECT id,public_id,title,destination,icon_key,status,sort_order FROM storefront_menu_shortcuts WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 FOR UPDATE',
        [request.auth.tenantId,store.id,request.params.shortcutId],
      );
      if(!found.rowCount)throw errors.notFound('MENU_SHORTCUT_NOT_FOUND','Menu shortcut not found');
      const row=found.rows[0];
      await client.query('DELETE FROM storefront_menu_shortcuts WHERE id=$1',[row.id]);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,
        action:'storefront.menu_shortcut.delete',targetType:'storefront_menu_shortcut',targetId:row.id,
        metadata:{public_id:row.public_id,title:row.title,destination:row.destination,icon_key:row.icon_key||null,status:row.status,sort_order:row.sort_order},requestIp:request.ip,requestId:request.id});
      return row.public_id;
    });
    return {data:{deleted:true,id:deleted}};
  });

  app.get('/v1/storefront/menu-shortcuts',{preHandler:[app.requireTenant]},async request=>{
    const store=await resolveStore(app.db,request.tenant.id,storeHeader(request));
    const result=await app.db.query(`${selectSql} WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.status='ACTIVE' ORDER BY s.sort_order,s.created_at,s.public_id`,[request.tenant.id,store.id]);
    return {data:{store:{id:store.public_id,name:store.name},menu_shortcuts:result.rows.map(storefrontRow)}};
  });
}
