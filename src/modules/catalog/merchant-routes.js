import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { publicId, uuid } from '../../core/identifiers.js';
import {
  assertFulfillmentModes, assertProductType, catalogSlug, productDetails, resolveCategoryId,
  resolveDefaultInventoryLocation, resolveProduct, resolveStore,
} from './service.js';

const productTypeSchema = { type: 'string', enum: ['PHYSICAL','FOOD','DIGITAL_IMAGE','DIGITAL_VIDEO','SERVICE'] };
const fulfillmentSchema = { type: 'string', enum: ['SHIPPING','LOCAL_DELIVERY','PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','NONE'] };
const moneySchema = { anyOf: [{ type: 'number', minimum: 0 }, { type: 'string', pattern: '^\\d+(?:\\.\\d{1,4})?$' }] };
const storeHeader = (request) => request.headers['x-store-id'] || null;

async function ensureInventoryItem(client, { tenantId, storeId, productId, variantId = null, sku = null, trackInventory = true }) {
  const existing = variantId
    ? await client.query('SELECT * FROM inventory_items WHERE tenant_id=$1 AND store_id=$2 AND variant_id=$3', [tenantId, storeId, variantId])
    : await client.query('SELECT * FROM inventory_items WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND variant_id IS NULL', [tenantId, storeId, productId]);
  if (existing.rowCount) {
    const updated = await client.query(
      `UPDATE inventory_items SET sku=$1, track_inventory=$2, status='ACTIVE', updated_at=now()
        WHERE tenant_id=$3 AND store_id=$4 AND id=$5 RETURNING *`,
      [sku ?? existing.rows[0].sku, trackInventory, tenantId, storeId, existing.rows[0].id],
    );
    return updated.rows[0];
  }
  const result = await client.query(
    `INSERT INTO inventory_items(id,public_id,tenant_id,store_id,product_id,variant_id,sku,track_inventory,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE') RETURNING *`,
    [uuid(), publicId('inv'), tenantId, storeId, productId, variantId, sku, trackInventory],
  );
  return result.rows[0];
}

export async function merchantCatalogRoutes(app) {
  app.post('/v1/merchant/categories', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 160 }, slug: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', maxLength: 5000 }, parent_id: { type: 'string', maxLength: 100 },
      status: { type: 'string', enum: ['ACTIVE','INACTIVE'], default: 'ACTIVE' }, sort_order: { type: 'integer', minimum: -100000, maximum: 100000, default: 0 },
    } } },
  }, async (request, reply) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const result = await app.db.transaction(async (client) => {
      let parentId = null;
      if (request.body.parent_id) {
        const parent = await client.query('SELECT id FROM categories WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3', [request.auth.tenantId, store.id, request.body.parent_id]);
        if (!parent.rowCount) throw errors.notFound('CATEGORY_PARENT_NOT_FOUND', 'Parent category not found');
        parentId = parent.rows[0].id;
      }
      const id = uuid(); const publicID = publicId('cat');
      const created = await client.query(
        `INSERT INTO categories(id,public_id,tenant_id,store_id,parent_id,slug,name,description,status,sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING public_id,slug,name,description,status,sort_order,created_at`,
        [id, publicID, request.auth.tenantId, store.id, parentId, catalogSlug(request.body.slug || request.body.name), request.body.name.trim(), request.body.description?.trim() || null, request.body.status || 'ACTIVE', request.body.sort_order || 0],
      );
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'catalog.category.create', targetType: 'category', targetId: id, metadata: { public_id: publicID, store_id: store.public_id }, requestIp: request.ip, requestId: request.id });
      return created.rows[0];
    });
    return reply.code(201).send({ data: { category: result } });
  });

  app.get('/v1/merchant/categories', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_READ)],
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const result = await app.db.query(
      `SELECT c.public_id,c.slug,c.name,c.description,c.status,c.sort_order,p.public_id AS parent_id,c.created_at,c.updated_at
         FROM categories c LEFT JOIN categories p ON p.id=c.parent_id AND p.tenant_id=c.tenant_id AND p.store_id=c.store_id
        WHERE c.tenant_id=$1 AND c.store_id=$2 ORDER BY c.sort_order,c.name`, [request.auth.tenantId, store.id],
    );
    return { data: { store: { id: store.public_id, name: store.name }, categories: result.rows } };
  });

  app.patch('/v1/merchant/categories/:categoryId', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 160 }, slug: { type: 'string', minLength: 1, maxLength: 120 },
      description: { anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'null' }] },
      status: { type: 'string', enum: ['ACTIVE','INACTIVE'] }, sort_order: { type: 'integer', minimum: -100000, maximum: 100000 },
    } } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const row = await app.db.transaction(async (client) => {
      const found = await client.query('SELECT * FROM categories WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 FOR UPDATE', [request.auth.tenantId, store.id, request.params.categoryId]);
      if (!found.rowCount) throw errors.notFound('CATEGORY_NOT_FOUND', 'Category not found');
      const current = found.rows[0]; const body = request.body || {};
      const updated = await client.query(
        `UPDATE categories SET slug=$1,name=$2,description=$3,status=$4,sort_order=$5,updated_at=now()
          WHERE tenant_id=$6 AND store_id=$7 AND id=$8
          RETURNING public_id,slug,name,description,status,sort_order,updated_at`,
        [body.slug ? catalogSlug(body.slug) : current.slug, body.name?.trim() || current.name,
          Object.hasOwn(body,'description') ? body.description?.trim() || null : current.description,
          body.status || current.status, body.sort_order ?? current.sort_order, request.auth.tenantId, store.id, current.id],
      );
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'catalog.category.update', targetType: 'category', targetId: current.id, metadata: { changed_fields: Object.keys(body) }, requestIp: request.ip, requestId: request.id });
      return updated.rows[0];
    });
    return { data: { category: row } };
  });

  app.post('/v1/merchant/products', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, required: ['name','product_type','base_price','fulfillment_modes'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 240 }, slug: { type: 'string', maxLength: 120 },
      category_id: { type: 'string', maxLength: 100 }, short_description: { type: 'string', maxLength: 1000 }, description: { type: 'string', maxLength: 30000 },
      product_type: productTypeSchema, status: { type: 'string', enum: ['DRAFT','PUBLISHED'], default: 'DRAFT' },
      base_price: moneySchema, compare_at_price: moneySchema, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      fulfillment_modes: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: fulfillmentSchema },
      track_inventory: { type: 'boolean', default: false }, low_stock_threshold: { type: 'integer', minimum: 0, maximum: 999999999, default: 0 },
      sku: { type: 'string', minLength: 1, maxLength: 120 }, metadata: { type: 'object' },
    } } },
  }, async (request, reply) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const modes = assertFulfillmentModes(request.body.fulfillment_modes); assertProductType(request.body.product_type);
    const row = await app.db.transaction(async (client) => {
      const categoryId = await resolveCategoryId(client, request.auth.tenantId, store.id, request.body.category_id);
      const settings = await client.query('SELECT currency FROM tenant_settings WHERE tenant_id=$1', [request.auth.tenantId]);
      const id = uuid(); const publicID = publicId('prd');
      const created = await client.query(
        `INSERT INTO products(id,public_id,tenant_id,store_id,category_id,slug,name,short_description,description,product_type,status,
                              base_price,compare_at_price,currency,track_inventory,low_stock_threshold,metadata,published_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,CASE WHEN $11='PUBLISHED' THEN now() ELSE NULL END)
         RETURNING *`,
        [id, publicID, request.auth.tenantId, store.id, categoryId, catalogSlug(request.body.slug || request.body.name), request.body.name.trim(),
          request.body.short_description?.trim() || null, request.body.description?.trim() || null, request.body.product_type, request.body.status || 'DRAFT',
          request.body.base_price, request.body.compare_at_price ?? null, request.body.currency || settings.rows[0].currency,
          Boolean(request.body.track_inventory), request.body.low_stock_threshold || 0, JSON.stringify(request.body.metadata || {})],
      );
      for (const mode of modes) await client.query('INSERT INTO product_fulfillment_modes(tenant_id,store_id,product_id,mode) VALUES($1,$2,$3,$4)', [request.auth.tenantId, store.id, id, mode]);
      if (request.body.track_inventory || request.body.sku) await ensureInventoryItem(client, { tenantId: request.auth.tenantId, storeId: store.id, productId: id, sku: request.body.sku || null, trackInventory: Boolean(request.body.track_inventory) });
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'catalog.product.create', targetType: 'product', targetId: id,
        metadata: { public_id: publicID, type: request.body.product_type, fulfillment_modes: modes }, requestIp: request.ip, requestId: request.id });
      return created.rows[0];
    });
    return reply.code(201).send({ data: { product: await productDetails(app.db, request.auth.tenantId, store.id, row.id) } });
  });

  app.get('/v1/merchant/products', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_READ)],
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      status: { type: 'string', enum: ['DRAFT','PUBLISHED','ARCHIVED'] }, product_type: productTypeSchema,
      category_id: { type: 'string', maxLength: 100 }, q: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
    } } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const values = [request.auth.tenantId, store.id]; let where = 'p.tenant_id=$1 AND p.store_id=$2';
    if (request.query.status) { values.push(request.query.status); where += ` AND p.status=$${values.length}`; }
    if (request.query.product_type) { values.push(request.query.product_type); where += ` AND p.product_type=$${values.length}`; }
    if (request.query.category_id) { values.push(request.query.category_id); where += ` AND c.public_id=$${values.length}`; }
    if (request.query.q) {
      values.push(request.query.q);
      const q = `$${values.length}`;
      where += ` AND (p.name ILIKE '%' || ${q} || '%' OR p.slug ILIKE '%' || ${q} || '%' OR COALESCE(p.short_description,'') ILIKE '%' || ${q} || '%')`;
    }
    values.push(request.query.limit || 50, request.query.offset || 0);
    const result = await app.db.query(
      `SELECT p.public_id,p.slug,p.name,p.product_type,p.status,p.base_price,p.compare_at_price,p.currency,p.track_inventory,p.created_at,p.updated_at,
              c.public_id AS category_id,c.name AS category_name,
              (SELECT url FROM product_media m WHERE m.tenant_id=p.tenant_id AND m.store_id=p.store_id AND m.product_id=p.id AND m.visibility='PUBLIC' AND m.status='ACTIVE' ORDER BY m.is_primary DESC,m.sort_order,m.created_at LIMIT 1) AS primary_media_url
         FROM products p LEFT JOIN categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id AND c.store_id=p.store_id
        WHERE ${where} ORDER BY p.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values,
    );
    return { data: { store: { id: store.public_id, name: store.name }, products: result.rows, limit: request.query.limit || 50, offset: request.query.offset || 0 } };
  });

  app.get('/v1/merchant/products/:productId', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_READ)],
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const found = await app.db.query('SELECT id FROM products WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3', [request.auth.tenantId, store.id, request.params.productId]);
    if (!found.rowCount) throw errors.notFound('PRODUCT_NOT_FOUND', 'Product not found');
    return { data: { product: await productDetails(app.db, request.auth.tenantId, store.id, found.rows[0].id) } };
  });

  app.patch('/v1/merchant/products/:productId', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 240 }, slug: { type: 'string', maxLength: 120 }, category_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      short_description: { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }] }, description: { anyOf: [{ type: 'string', maxLength: 30000 }, { type: 'null' }] },
      status: { type: 'string', enum: ['DRAFT','PUBLISHED','ARCHIVED'] }, base_price: moneySchema, compare_at_price: { anyOf: [moneySchema, { type: 'null' }] },
      fulfillment_modes: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: fulfillmentSchema },
      track_inventory: { type: 'boolean' }, low_stock_threshold: { type: 'integer', minimum: 0, maximum: 999999999 }, metadata: { type: 'object' },
    } } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const updatedId = await app.db.transaction(async (client) => {
      const current = await resolveProduct(client, request.auth.tenantId, store.id, request.params.productId, { forUpdate: true });
      const body = request.body || {};
      const categoryId = Object.hasOwn(body,'category_id') ? await resolveCategoryId(client, request.auth.tenantId, store.id, body.category_id) : current.category_id;
      const modes = body.fulfillment_modes ? assertFulfillmentModes(body.fulfillment_modes) : null;
      await client.query(
        `UPDATE products SET category_id=$1,slug=$2,name=$3,short_description=$4,description=$5,status=$6,base_price=$7,compare_at_price=$8,
             track_inventory=$9,low_stock_threshold=$10,metadata=$11::jsonb,
             published_at=CASE WHEN $6='PUBLISHED' THEN COALESCE(published_at,now()) ELSE published_at END,updated_at=now()
          WHERE tenant_id=$12 AND store_id=$13 AND id=$14`,
        [categoryId, body.slug ? catalogSlug(body.slug) : current.slug, body.name?.trim() || current.name,
          Object.hasOwn(body,'short_description') ? body.short_description?.trim() || null : current.short_description,
          Object.hasOwn(body,'description') ? body.description?.trim() || null : current.description,
          body.status || current.status, body.base_price ?? current.base_price,
          Object.hasOwn(body,'compare_at_price') ? body.compare_at_price : current.compare_at_price,
          body.track_inventory ?? current.track_inventory, body.low_stock_threshold ?? current.low_stock_threshold,
          JSON.stringify(body.metadata ?? current.metadata), request.auth.tenantId, store.id, current.id],
      );
      if (modes) {
        await client.query('DELETE FROM product_fulfillment_modes WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3', [request.auth.tenantId, store.id, current.id]);
        for (const mode of modes) await client.query('INSERT INTO product_fulfillment_modes(tenant_id,store_id,product_id,mode) VALUES($1,$2,$3,$4)', [request.auth.tenantId, store.id, current.id, mode]);
      }
      if (body.track_inventory === true) await ensureInventoryItem(client, { tenantId: request.auth.tenantId, storeId: store.id, productId: current.id, trackInventory: true });
      if (body.track_inventory === false) await client.query('UPDATE inventory_items SET track_inventory=false,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3', [request.auth.tenantId, store.id, current.id]);
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'catalog.product.update', targetType: 'product', targetId: current.id, metadata: { changed_fields: Object.keys(body) }, requestIp: request.ip, requestId: request.id });
      return current.id;
    });
    return { data: { product: await productDetails(app.db, request.auth.tenantId, store.id, updatedId) } };
  });

  app.post('/v1/merchant/products/:productId/variants', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, required: ['title'], properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 }, sku: { type: 'string', minLength: 1, maxLength: 120 }, barcode: { type: 'string', maxLength: 120 },
      attributes: { type: 'object' }, price_override: moneySchema, compare_at_price_override: moneySchema,
      status: { type: 'string', enum: ['ACTIVE','INACTIVE'], default: 'ACTIVE' }, track_inventory: { type: 'boolean', default: false },
      low_stock_threshold: { type: 'integer', minimum: 0, maximum: 999999999, default: 0 }, sort_order: { type: 'integer', minimum: -100000, maximum: 100000, default: 0 },
    } } },
  }, async (request, reply) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const created = await app.db.transaction(async (client) => {
      const product = await resolveProduct(client, request.auth.tenantId, store.id, request.params.productId);
      const id = uuid(); const publicID = publicId('var');
      const result = await client.query(
        `INSERT INTO product_variants(id,public_id,tenant_id,store_id,product_id,sku,barcode,title,attributes,price_override,compare_at_price_override,status,track_inventory,low_stock_threshold,sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
         RETURNING public_id,sku,barcode,title,attributes,price_override,compare_at_price_override,status,track_inventory,low_stock_threshold,sort_order`,
        [id, publicID, request.auth.tenantId, store.id, product.id, request.body.sku || null, request.body.barcode || null, request.body.title.trim(), JSON.stringify(request.body.attributes || {}),
          request.body.price_override ?? null, request.body.compare_at_price_override ?? null, request.body.status || 'ACTIVE', Boolean(request.body.track_inventory), request.body.low_stock_threshold || 0, request.body.sort_order || 0],
      );
      if (request.body.track_inventory || request.body.sku) await ensureInventoryItem(client, { tenantId: request.auth.tenantId, storeId: store.id, productId: product.id, variantId: id, sku: request.body.sku || null, trackInventory: Boolean(request.body.track_inventory) });
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'catalog.variant.create', targetType: 'product_variant', targetId: id, metadata: { product_id: product.public_id, public_id: publicID }, requestIp: request.ip, requestId: request.id });
      return result.rows[0];
    });
    return reply.code(201).send({ data: { variant: created } });
  });

  app.patch('/v1/merchant/products/:productId/variants/:variantId', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 }, sku: { anyOf: [{ type: 'string', minLength: 1, maxLength: 120 }, { type: 'null' }] },
      barcode: { anyOf: [{ type: 'string', maxLength: 120 }, { type: 'null' }] }, attributes: { type: 'object' }, price_override: { anyOf: [moneySchema,{type:'null'}] },
      compare_at_price_override: { anyOf: [moneySchema,{type:'null'}] }, status: { type: 'string', enum: ['ACTIVE','INACTIVE'] }, track_inventory: { type: 'boolean' },
      low_stock_threshold: { type: 'integer', minimum: 0, maximum: 999999999 }, sort_order: { type: 'integer', minimum: -100000, maximum: 100000 },
    } } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const row = await app.db.transaction(async (client) => {
      const product = await resolveProduct(client, request.auth.tenantId, store.id, request.params.productId);
      const found = await client.query('SELECT * FROM product_variants WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND public_id=$4 FOR UPDATE', [request.auth.tenantId, store.id, product.id, request.params.variantId]);
      if (!found.rowCount) throw errors.notFound('VARIANT_NOT_FOUND', 'Variant not found');
      const current = found.rows[0]; const b = request.body || {};
      const updated = await client.query(
        `UPDATE product_variants SET sku=$1,barcode=$2,title=$3,attributes=$4::jsonb,price_override=$5,compare_at_price_override=$6,status=$7,track_inventory=$8,low_stock_threshold=$9,sort_order=$10,updated_at=now()
          WHERE tenant_id=$11 AND store_id=$12 AND id=$13
          RETURNING public_id,sku,barcode,title,attributes,price_override,compare_at_price_override,status,track_inventory,low_stock_threshold,sort_order`,
        [Object.hasOwn(b,'sku') ? b.sku : current.sku, Object.hasOwn(b,'barcode') ? b.barcode : current.barcode, b.title?.trim() || current.title,
          JSON.stringify(b.attributes ?? current.attributes), Object.hasOwn(b,'price_override') ? b.price_override : current.price_override,
          Object.hasOwn(b,'compare_at_price_override') ? b.compare_at_price_override : current.compare_at_price_override,
          b.status || current.status, b.track_inventory ?? current.track_inventory, b.low_stock_threshold ?? current.low_stock_threshold, b.sort_order ?? current.sort_order,
          request.auth.tenantId, store.id, current.id],
      );
      if (b.track_inventory === true || Object.hasOwn(b,'sku')) await ensureInventoryItem(client, { tenantId: request.auth.tenantId, storeId: store.id, productId: product.id, variantId: current.id, sku: Object.hasOwn(b,'sku') ? b.sku : current.sku, trackInventory: b.track_inventory ?? current.track_inventory });
      if (b.track_inventory === false) await client.query('UPDATE inventory_items SET track_inventory=false,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND variant_id=$3', [request.auth.tenantId, store.id, current.id]);
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId, action: 'catalog.variant.update', targetType: 'product_variant', targetId: current.id, metadata: { changed_fields: Object.keys(b) }, requestIp: request.ip, requestId: request.id });
      return updated.rows[0];
    });
    return { data: { variant: row } };
  });

  app.post('/v1/merchant/products/:productId/media', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      asset_id: { type: 'string', maxLength: 100 }, variant_id: { type: 'string', maxLength: 100 }, media_type: { type: 'string', enum: ['IMAGE','VIDEO'] }, visibility: { type: 'string', enum: ['PUBLIC','PRIVATE'] },
      url: { type: 'string', maxLength: 4000 }, storage_key: { type: 'string', maxLength: 1000 }, alt_text: { type: 'string', maxLength: 500 },
      sort_order: { type: 'integer', minimum: -100000, maximum: 100000, default: 0 }, is_primary: { type: 'boolean', default: false }, metadata: { type: 'object' },
    } } },
  }, async (request, reply) => {
    const b=request.body||{}; if(!b.asset_id && (!b.media_type || !b.visibility)) throw errors.badRequest('MEDIA_SOURCE_REQUIRED','Choose an asset or provide media type and visibility');
    if (!b.asset_id && b.visibility === 'PUBLIC' && !b.url) throw errors.badRequest('PUBLIC_MEDIA_URL_REQUIRED', 'Public media requires url');
    if (!b.asset_id && b.visibility === 'PRIVATE' && (!b.storage_key || b.url)) throw errors.badRequest('PRIVATE_MEDIA_INVALID', 'Private media requires storage_key and must not expose a public url');
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive: false });
    const row = await app.db.transaction(async (client) => {
      const product = await resolveProduct(client, request.auth.tenantId, store.id, request.params.productId); let asset=null;
      if(b.asset_id){const ar=await client.query("SELECT * FROM media_assets WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 AND status='ACTIVE'",[request.auth.tenantId,store.id,b.asset_id]);if(!ar.rowCount)throw errors.notFound('ASSET_NOT_FOUND','Media asset not found');asset=ar.rows[0];}
      let variantId = null;
      if (b.variant_id) { const v = await client.query('SELECT id FROM product_variants WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND public_id=$4', [request.auth.tenantId, store.id, product.id, b.variant_id]); if (!v.rowCount) throw errors.notFound('VARIANT_NOT_FOUND', 'Variant not found'); variantId = v.rows[0].id; }
      if (b.is_primary) await client.query(`UPDATE product_media SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND ${variantId ? 'variant_id=$4' : 'variant_id IS NULL'}`, variantId ? [request.auth.tenantId,store.id,product.id,variantId] : [request.auth.tenantId,store.id,product.id]);
      const id=uuid(); const publicID=publicId('med'); const mediaType=asset?.media_type||b.media_type; const visibility=asset?.visibility||b.visibility; const url=asset?.url||b.url||null; const storageKey=asset?.storage_key||b.storage_key||null;
      const created = await client.query(`INSERT INTO product_media(id,public_id,tenant_id,store_id,product_id,variant_id,asset_id,media_type,visibility,url,storage_key,alt_text,sort_order,is_primary,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING public_id,media_type,visibility,url,storage_key,alt_text,sort_order,is_primary,status,metadata`,[id,publicID,request.auth.tenantId,store.id,product.id,variantId,asset?.id||null,mediaType,visibility,url,storageKey,b.alt_text||null,b.sort_order||0,Boolean(b.is_primary),JSON.stringify(b.metadata||{})]);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'catalog.media.create',targetType:'product_media',targetId:id,metadata:{product_id:product.public_id,asset_id:asset?.public_id||null,visibility},requestIp:request.ip,requestId:request.id}); return {...created.rows[0],asset_id:asset?.public_id||null};
    }); return reply.code(201).send({data:{media:row}});
  });

  app.patch('/v1/merchant/products/:productId/media/:mediaId',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_WRITE)],schema:{body:{type:'object',additionalProperties:false,properties:{variant_id:{anyOf:[{type:'string',maxLength:100},{type:'null'}]},alt_text:{anyOf:[{type:'string',maxLength:500},{type:'null'}]},sort_order:{type:'integer',minimum:-100000,maximum:100000},is_primary:{type:'boolean'},status:{type:'string',enum:['ACTIVE','INACTIVE']}}}}},async(request)=>{const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});const row=await app.db.transaction(async(client)=>{const product=await resolveProduct(client,request.auth.tenantId,store.id,request.params.productId);const f=await client.query('SELECT * FROM product_media WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND public_id=$4 FOR UPDATE',[request.auth.tenantId,store.id,product.id,request.params.mediaId]);if(!f.rowCount)throw errors.notFound('MEDIA_NOT_FOUND','Product media not found');const cur=f.rows[0],body=request.body||{};let variantId=cur.variant_id;if(Object.hasOwn(body,'variant_id')){if(body.variant_id===null)variantId=null;else{const vr=await client.query('SELECT id FROM product_variants WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND public_id=$4',[request.auth.tenantId,store.id,product.id,body.variant_id]);if(!vr.rowCount)throw errors.notFound('VARIANT_NOT_FOUND','Variant not found');variantId=vr.rows[0].id;}}const primary=(body.status==='INACTIVE')?false:(body.is_primary??cur.is_primary);if(primary)await client.query(`UPDATE product_media SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND id<>$4 AND ${variantId?'variant_id=$5':'variant_id IS NULL'}`,variantId?[request.auth.tenantId,store.id,product.id,cur.id,variantId]:[request.auth.tenantId,store.id,product.id,cur.id]);const u=await client.query('UPDATE product_media SET variant_id=$1,alt_text=$2,sort_order=$3,is_primary=$4,status=$5,updated_at=now() WHERE id=$6 RETURNING public_id,media_type,visibility,url,storage_key,alt_text,sort_order,is_primary,status,metadata',[variantId,Object.hasOwn(body,'alt_text')?body.alt_text:cur.alt_text,body.sort_order??cur.sort_order,primary,body.status||cur.status,cur.id]);await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'catalog.media.update',targetType:'product_media',targetId:cur.id,metadata:{changed_fields:Object.keys(body)},requestIp:request.ip,requestId:request.id});return u.rows[0];});return{data:{media:row}};});

  app.put('/v1/merchant/products/:productId/media/order',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_WRITE)],schema:{body:{type:'object',additionalProperties:false,required:['media_ids'],properties:{media_ids:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'string',maxLength:100}}}}}},async(request)=>{const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});await app.db.transaction(async(client)=>{const product=await resolveProduct(client,request.auth.tenantId,store.id,request.params.productId);const r=await client.query('SELECT public_id FROM product_media WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND public_id=ANY($4::text[])',[request.auth.tenantId,store.id,product.id,request.body.media_ids]);if(r.rowCount!==request.body.media_ids.length)throw errors.badRequest('MEDIA_ORDER_INVALID','Every media ID must belong to the product');for(let i=0;i<request.body.media_ids.length;i++)await client.query('UPDATE product_media SET sort_order=$1,updated_at=now() WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4 AND public_id=$5',[i*10,request.auth.tenantId,store.id,product.id,request.body.media_ids[i]]);await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'catalog.media.reorder',targetType:'product',targetId:product.id,metadata:{media_count:request.body.media_ids.length},requestIp:request.ip,requestId:request.id});});return{data:{reordered:true}};});

  app.delete('/v1/merchant/products/:productId/media/:mediaId',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CATALOG_WRITE)]},async(request)=>{const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});await app.db.transaction(async(client)=>{const product=await resolveProduct(client,request.auth.tenantId,store.id,request.params.productId);const r=await client.query("UPDATE product_media SET status='INACTIVE',is_primary=false,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND public_id=$4 RETURNING id",[request.auth.tenantId,store.id,product.id,request.params.mediaId]);if(!r.rowCount)throw errors.notFound('MEDIA_NOT_FOUND','Product media not found');await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'catalog.media.deactivate',targetType:'product_media',targetId:r.rows[0].id,metadata:{product_id:product.public_id},requestIp:request.ip,requestId:request.id});});return{data:{deactivated:true}};});

  app.post('/v1/merchant/products/:productId/modifier-groups', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type:'object',additionalProperties:false,required:['name'],properties:{
      name:{type:'string',minLength:1,maxLength:160},required:{type:'boolean',default:false},min_selections:{type:'integer',minimum:0,maximum:100,default:0},max_selections:{type:'integer',minimum:1,maximum:100,default:1},sort_order:{type:'integer',minimum:-100000,maximum:100000,default:0},status:{type:'string',enum:['ACTIVE','INACTIVE'],default:'ACTIVE'}
    } } },
  }, async (request,reply)=>{
    const min=request.body.min_selections||0; const max=request.body.max_selections||1;
    if(max<min || (request.body.required && min<1)) throw errors.badRequest('MODIFIER_SELECTION_RULE_INVALID','Modifier selection limits are invalid');
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const row=await app.db.transaction(async(client)=>{const product=await resolveProduct(client,request.auth.tenantId,store.id,request.params.productId); const id=uuid(); const publicID=publicId('modg');
      const result=await client.query(`INSERT INTO product_modifier_groups(id,public_id,tenant_id,store_id,product_id,name,required,min_selections,max_selections,sort_order,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING public_id,name,required,min_selections,max_selections,sort_order,status`,[id,publicID,request.auth.tenantId,store.id,product.id,request.body.name.trim(),Boolean(request.body.required),min,max,request.body.sort_order||0,request.body.status||'ACTIVE']);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'catalog.modifier_group.create',targetType:'modifier_group',targetId:id,metadata:{product_id:product.public_id},requestIp:request.ip,requestId:request.id}); return result.rows[0];});
    return reply.code(201).send({data:{modifier_group:row}});
  });

  app.post('/v1/merchant/products/:productId/modifier-groups/:groupId/options', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema:{body:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:160},price_delta:{anyOf:[{type:'number'},{type:'string',pattern:'^-?\\d+(?:\\.\\d{1,4})?$'}]},sort_order:{type:'integer',minimum:-100000,maximum:100000,default:0},status:{type:'string',enum:['ACTIVE','INACTIVE'],default:'ACTIVE'}}}},
  },async(request,reply)=>{const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const row=await app.db.transaction(async(client)=>{const product=await resolveProduct(client,request.auth.tenantId,store.id,request.params.productId); const group=await client.query('SELECT id FROM product_modifier_groups WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND public_id=$4',[request.auth.tenantId,store.id,product.id,request.params.groupId]); if(!group.rowCount) throw errors.notFound('MODIFIER_GROUP_NOT_FOUND','Modifier group not found');
      const id=uuid(); const publicID=publicId('modo'); const result=await client.query(`INSERT INTO product_modifier_options(id,public_id,tenant_id,store_id,product_id,group_id,name,price_delta,sort_order,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING public_id,name,price_delta,sort_order,status`,[id,publicID,request.auth.tenantId,store.id,product.id,group.rows[0].id,request.body.name.trim(),request.body.price_delta??0,request.body.sort_order||0,request.body.status||'ACTIVE']);
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'catalog.modifier_option.create',targetType:'modifier_option',targetId:id,metadata:{product_id:product.public_id,group_id:request.params.groupId},requestIp:request.ip,requestId:request.id}); return result.rows[0];}); return reply.code(201).send({data:{modifier_option:row}});});
}
