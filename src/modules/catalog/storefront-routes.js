import { errors } from '../../core/errors.js';
import { productDetails, resolveStore } from './service.js';

export async function storefrontCatalogRoutes(app) {
  app.get('/v1/storefront/categories', {
    preHandler: [app.requireTenant],
  }, async (request) => {
    const store = await resolveStore(app.db, request.tenant.id, request.headers['x-store-id'] || null);
    const result = await app.db.query(
      `SELECT c.public_id,c.slug,c.name,c.description,c.sort_order,p.public_id AS parent_id
         FROM categories c LEFT JOIN categories p ON p.id=c.parent_id AND p.tenant_id=c.tenant_id AND p.store_id=c.store_id
        WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.status='ACTIVE'
          AND EXISTS(SELECT 1 FROM products pr WHERE pr.tenant_id=c.tenant_id AND pr.store_id=c.store_id AND pr.category_id=c.id AND pr.status='PUBLISHED')
        ORDER BY c.sort_order,c.name`, [request.tenant.id, store.id],
    );
    return { data: { store: { id: store.public_id, name: store.name }, categories: result.rows } };
  });

  app.get('/v1/storefront/products', {
    preHandler: [app.requireTenant],
    schema: { querystring: { type:'object',additionalProperties:false,properties:{
      category:{type:'string',maxLength:120},product_type:{type:'string',enum:['PHYSICAL','FOOD','DIGITAL_IMAGE','DIGITAL_VIDEO','SERVICE']},q:{type:'string',maxLength:200},
      limit:{type:'integer',minimum:1,maximum:100,default:24},offset:{type:'integer',minimum:0,maximum:1000000,default:0}
    } } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.tenant.id, request.headers['x-store-id'] || null);
    const values=[request.tenant.id,store.id]; let where="p.tenant_id=$1 AND p.store_id=$2 AND p.status='PUBLISHED'";
    if(request.query.category){values.push(request.query.category);where+=` AND c.slug=$${values.length}`;}
    if(request.query.product_type){values.push(request.query.product_type);where+=` AND p.product_type=$${values.length}`;}
    if(request.query.q){values.push(request.query.q);const p=`$${values.length}`;where+=` AND (p.name ILIKE '%'||${p}||'%' OR p.short_description ILIKE '%'||${p}||'%')`;}
    values.push(request.query.limit||24,request.query.offset||0);
    const result=await app.db.query(
      `SELECT p.public_id,p.slug,p.name,p.short_description,p.product_type,p.base_price,p.compare_at_price,p.currency,p.track_inventory,
              c.public_id AS category_id,c.slug AS category_slug,c.name AS category_name,
              (SELECT m.url FROM product_media m WHERE m.tenant_id=p.tenant_id AND m.store_id=p.store_id AND m.product_id=p.id AND m.visibility='PUBLIC' AND m.status='ACTIVE' ORDER BY m.is_primary DESC,m.sort_order,m.created_at LIMIT 1) AS primary_media_url,
              CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_items ti WHERE ti.tenant_id=p.tenant_id AND ti.store_id=p.store_id AND ti.product_id=p.id AND ti.status='ACTIVE' AND ti.track_inventory=true) THEN true ELSE COALESCE((SELECT SUM(b.on_hand-b.reserved)>0 FROM inventory_items i LEFT JOIN inventory_balances b ON b.tenant_id=i.tenant_id AND b.store_id=i.store_id AND b.inventory_item_id=i.id WHERE i.tenant_id=p.tenant_id AND i.store_id=p.store_id AND i.product_id=p.id AND i.status='ACTIVE' AND i.track_inventory=true),false) END AS in_stock
         FROM products p LEFT JOIN categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id AND c.store_id=p.store_id
        WHERE ${where} ORDER BY p.published_at DESC NULLS LAST,p.created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
    return {data:{store:{id:store.public_id,name:store.name},products:result.rows,limit:request.query.limit||24,offset:request.query.offset||0}};
  });

  app.get('/v1/storefront/products/:slug', { preHandler:[app.requireTenant] }, async(request)=>{
    const store=await resolveStore(app.db,request.tenant.id,request.headers['x-store-id']||null);
    const found=await app.db.query("SELECT id FROM products WHERE tenant_id=$1 AND store_id=$2 AND slug=$3 AND status='PUBLISHED'",[request.tenant.id,store.id,request.params.slug]);
    if(!found.rowCount) throw errors.notFound('PRODUCT_NOT_FOUND','Product not found');
    return {data:{store:{id:store.public_id,name:store.name},product:await productDetails(app.db,request.tenant.id,store.id,found.rows[0].id,{publicOnly:true})}};
  });
}
