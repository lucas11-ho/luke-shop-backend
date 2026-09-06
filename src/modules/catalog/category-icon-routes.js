import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { publicPlatformIconReference, validatePlatformIconReference } from '../icons/reference-policy.js';
import { resolveStore } from './service.js';

const storeHeader = request => request.headers['x-store-id'] || null;
const iconKeySchema = { anyOf:[{type:'string',minLength:3,maxLength:80},{type:'null'}] };

export async function categoryIconRoutes(app) {
  app.get('/v1/merchant/category-icons', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_READ)],
  }, async request => {
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const result=await app.db.query(
      `SELECT public_id AS category_id,icon_key FROM categories
        WHERE tenant_id=$1 AND store_id=$2 ORDER BY sort_order,name`,
      [request.auth.tenantId,store.id],
    );
    return {data:{store:{id:store.public_id,name:store.name},category_icons:result.rows}};
  });

  app.put('/v1/merchant/categories/:categoryId/icon', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema:{body:{type:'object',additionalProperties:false,required:['icon_key'],properties:{icon_key:iconKeySchema}}},
  }, async request => {
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const row=await app.db.transaction(async client=>{
      const found=await client.query(
        'SELECT id,public_id,icon_key FROM categories WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 FOR UPDATE',
        [request.auth.tenantId,store.id,request.params.categoryId],
      );
      if(!found.rowCount)throw errors.notFound('CATEGORY_NOT_FOUND','Category not found');
      const current=found.rows[0];
      const iconKey=await validatePlatformIconReference(client,request.body.icon_key,{scope:'CATEGORY',errorCode:'CATEGORY_ICON_NOT_ALLOWED'});
      await client.query('UPDATE categories SET icon_key=$1,updated_at=now() WHERE id=$2',[iconKey,current.id]);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,
        action:'catalog.category.icon.update',targetType:'category',targetId:current.id,
        metadata:{public_id:current.public_id,previous_icon_key:current.icon_key||null,icon_key:iconKey},requestIp:request.ip,requestId:request.id});
      return {category_id:current.public_id,icon_key:iconKey};
    });
    return {data:{category_icon:row}};
  });

  app.get('/v1/storefront/category-icons', {
    preHandler:[app.requireTenant],
  }, async request=>{
    const store=await resolveStore(app.db,request.tenant.id,storeHeader(request));
    const result=await app.db.query(
      `SELECT c.public_id AS category_id,
              i.key AS icon_key,i.source_type AS icon_source_type,i.library_pack AS icon_library_pack,
              i.library_icon AS icon_library_icon,i.color_mode AS icon_color_mode,
              EXISTS(SELECT 1 FROM platform_icon_assets al WHERE al.icon_id=i.id AND al.variant='LIGHT') AS icon_has_light_asset,
              EXISTS(SELECT 1 FROM platform_icon_assets ad WHERE ad.icon_id=i.id AND ad.variant='DARK') AS icon_has_dark_asset
         FROM categories c
         LEFT JOIN platform_icons i ON i.key=c.icon_key
        WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.status='ACTIVE'
          AND EXISTS(SELECT 1 FROM products p WHERE p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.category_id=c.id AND p.status='PUBLISHED')
        ORDER BY c.sort_order,c.name`,
      [request.tenant.id,store.id],
    );
    return {data:{store:{id:store.public_id,name:store.name},category_icons:result.rows.map(row=>({category_id:row.category_id,icon:publicPlatformIconReference(row)}))}};
  });
}
