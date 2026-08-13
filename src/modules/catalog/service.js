import { errors } from '../../core/errors.js';

const PRODUCT_TYPES = new Set(['PHYSICAL', 'FOOD', 'DIGITAL_IMAGE', 'DIGITAL_VIDEO', 'SERVICE']);
const FULFILLMENT_MODES = new Set(['SHIPPING', 'LOCAL_DELIVERY', 'PICKUP', 'DIGITAL_DOWNLOAD', 'DIGITAL_ACCESS', 'NONE']);

export function catalogSlug(value) {
  const slug = String(value || '').trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(slug)) {
    throw errors.badRequest('CATALOG_SLUG_INVALID', 'Slug must contain letters, numbers, and internal hyphens');
  }
  return slug;
}

export function assertProductType(value) {
  if (!PRODUCT_TYPES.has(value)) throw errors.badRequest('PRODUCT_TYPE_INVALID', 'Invalid product type');
  return value;
}

export function assertFulfillmentModes(values) {
  if (!Array.isArray(values) || values.length === 0) throw errors.badRequest('FULFILLMENT_REQUIRED', 'At least one fulfillment mode is required');
  const unique = [...new Set(values)];
  for (const value of unique) if (!FULFILLMENT_MODES.has(value)) {
    throw errors.badRequest('FULFILLMENT_MODE_INVALID', `Invalid fulfillment mode: ${value}`);
  }
  if (unique.includes('NONE') && unique.length > 1) throw errors.badRequest('FULFILLMENT_MODE_INVALID', 'NONE cannot be combined with another fulfillment mode');
  return unique;
}

export async function resolveStore(db, tenantId, storePublicId = null, { requireActive = true } = {}) {
  const values = [tenantId];
  let filter = 's.tenant_id = $1';
  if (storePublicId) {
    values.push(storePublicId);
    filter += ` AND s.public_id = $${values.length}`;
  } else {
    filter += ' AND s.is_primary = true';
  }
  if (requireActive) filter += " AND s.status = 'ACTIVE'";
  const result = await db.query(
    `SELECT s.id, s.public_id, s.tenant_id, s.slug, s.name, s.status, s.is_primary
       FROM stores s WHERE ${filter} ORDER BY s.is_primary DESC, s.created_at ASC LIMIT 1`, values,
  );
  if (!result.rowCount) throw errors.notFound('STORE_NOT_FOUND', 'Store not found');
  return result.rows[0];
}


export async function resolveStoreBySlug(db, tenantId, storeSlug = null, { requireActive = true } = {}) {
  if (!storeSlug) return resolveStore(db, tenantId, null, { requireActive });
  const slug = catalogSlug(storeSlug);
  const values = [tenantId, slug];
  let filter = 's.tenant_id = $1 AND s.slug = $2';
  if (requireActive) filter += " AND s.status = 'ACTIVE'";
  const result = await db.query(
    `SELECT s.id, s.public_id, s.tenant_id, s.slug, s.name, s.status, s.is_primary
       FROM stores s WHERE ${filter} LIMIT 1`, values,
  );
  if (!result.rowCount) throw errors.notFound('STORE_NOT_FOUND', 'Store not found');
  return result.rows[0];
}

export async function resolveCategoryId(client, tenantId, storeId, categoryPublicId) {
  if (!categoryPublicId) return null;
  const found = await client.query(
    'SELECT id FROM categories WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3',
    [tenantId, storeId, categoryPublicId],
  );
  if (!found.rowCount) throw errors.notFound('CATEGORY_NOT_FOUND', 'Category not found');
  return found.rows[0].id;
}

export async function resolveProduct(client, tenantId, storeId, productPublicId, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT * FROM products WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId, storeId, productPublicId],
  );
  if (!result.rowCount) throw errors.notFound('PRODUCT_NOT_FOUND', 'Product not found');
  return result.rows[0];
}

export async function resolveDefaultInventoryLocation(client, tenantId, storeId) {
  const found = await client.query(
    `SELECT id, public_id, name, code FROM inventory_locations
      WHERE tenant_id=$1 AND store_id=$2 AND status='ACTIVE'
      ORDER BY is_default DESC, created_at ASC LIMIT 1`,
    [tenantId, storeId],
  );
  if (!found.rowCount) throw errors.conflict('INVENTORY_LOCATION_REQUIRED', 'Create an active inventory location first');
  return found.rows[0];
}

export async function productDetails(db, tenantId, storeId, productId, { publicOnly = false } = {}) {
  const productResult = await db.query(
    `SELECT p.public_id, p.slug, p.name, p.short_description, p.description, p.product_type, p.status,
            p.base_price, p.compare_at_price, p.currency, p.track_inventory, p.low_stock_threshold,
            p.metadata, p.published_at, p.created_at, p.updated_at,
            c.public_id AS category_id, c.slug AS category_slug, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id AND c.store_id=p.store_id
      WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3${publicOnly ? " AND p.status='PUBLISHED'" : ''}`,
    [tenantId, storeId, productId],
  );
  if (!productResult.rowCount) throw errors.notFound('PRODUCT_NOT_FOUND', 'Product not found');
  const product = productResult.rows[0];
  if (publicOnly) delete product.metadata;
  const [fulfillment, variants, media, groups, options, inventory] = await Promise.all([
    db.query('SELECT mode FROM product_fulfillment_modes WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 ORDER BY mode', [tenantId, storeId, productId]),
    db.query(
      `SELECT public_id, sku, barcode, title, attributes, price_override, compare_at_price_override,
              status, track_inventory, low_stock_threshold, sort_order
         FROM product_variants WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3${publicOnly ? " AND status='ACTIVE'" : ''}
         ORDER BY sort_order, created_at`, [tenantId, storeId, productId]),
    db.query(
      `SELECT m.public_id, a.public_id AS asset_id, v.public_id AS variant_id, m.media_type, m.visibility, m.url,
              ${publicOnly ? 'NULL::text' : 'm.storage_key'} AS storage_key, m.alt_text, m.sort_order, m.is_primary, m.status, m.metadata
         FROM product_media m
         LEFT JOIN media_assets a ON a.id=m.asset_id AND a.tenant_id=m.tenant_id AND a.store_id=m.store_id
         LEFT JOIN product_variants v ON v.id=m.variant_id AND v.tenant_id=m.tenant_id AND v.store_id=m.store_id
        WHERE m.tenant_id=$1 AND m.store_id=$2 AND m.product_id=$3${publicOnly ? " AND m.visibility='PUBLIC' AND m.status='ACTIVE'" : ''}
        ORDER BY m.is_primary DESC, m.sort_order, m.created_at`, [tenantId, storeId, productId]),
    db.query(
      `SELECT public_id, name, required, min_selections, max_selections, sort_order, status
         FROM product_modifier_groups WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3${publicOnly ? " AND status='ACTIVE'" : ''}
         ORDER BY sort_order, created_at`, [tenantId, storeId, productId]),
    db.query(
      `SELECT o.public_id, g.public_id AS group_id, o.name, o.price_delta, o.sort_order, o.status
         FROM product_modifier_options o
         JOIN product_modifier_groups g ON g.id=o.group_id AND g.tenant_id=o.tenant_id AND g.store_id=o.store_id AND g.product_id=o.product_id
        WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.product_id=$3${publicOnly ? " AND o.status='ACTIVE' AND g.status='ACTIVE'" : ''}
        ORDER BY g.sort_order, o.sort_order, o.created_at`, [tenantId, storeId, productId]),
    db.query(
      `SELECT i.public_id AS inventory_item_id, v.public_id AS variant_id, i.sku, i.track_inventory,
              COALESCE(SUM(b.on_hand),0)::bigint AS on_hand,
              COALESCE(SUM(b.reserved),0)::bigint AS reserved,
              COALESCE(SUM(b.on_hand-b.reserved),0)::bigint AS available
         FROM inventory_items i
         LEFT JOIN product_variants v ON v.id=i.variant_id AND v.tenant_id=i.tenant_id AND v.store_id=i.store_id
         LEFT JOIN inventory_balances b ON b.tenant_id=i.tenant_id AND b.store_id=i.store_id AND b.inventory_item_id=i.id
        WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.product_id=$3 AND i.status='ACTIVE'
        GROUP BY i.id, i.public_id, v.public_id, i.sku ORDER BY v.public_id NULLS FIRST`, [tenantId, storeId, productId]),
  ]);
  const optionsByGroup = new Map();
  for (const row of options.rows) {
    const values = optionsByGroup.get(row.group_id) || [];
    values.push({ id: row.public_id, name: row.name, price_delta: row.price_delta, sort_order: row.sort_order, status: row.status });
    optionsByGroup.set(row.group_id, values);
  }
  const modifierGroups = groups.rows.map((row) => ({ ...row, options: optionsByGroup.get(row.public_id) || [] }));
  const inventoryRows = inventory.rows.map((row) => ({ ...row, on_hand: Number(row.on_hand), reserved: Number(row.reserved), available: Number(row.available) }));
  const safeVariants = publicOnly ? variants.rows.map((row) => ({
    public_id: row.public_id, sku: row.sku, title: row.title, attributes: row.attributes,
    price_override: row.price_override, compare_at_price_override: row.compare_at_price_override, sort_order: row.sort_order,
  })) : variants.rows;
  const safeMedia = publicOnly ? media.rows.map((row) => ({
    public_id: row.public_id, asset_id: row.asset_id, variant_id: row.variant_id, media_type: row.media_type, url: row.url,
    alt_text: row.alt_text, sort_order: row.sort_order, is_primary: row.is_primary,
  })) : media.rows;
  const safeModifierGroups = publicOnly ? modifierGroups.map((group) => ({
    public_id: group.public_id, name: group.name, required: group.required, min_selections: group.min_selections,
    max_selections: group.max_selections, sort_order: group.sort_order,
    options: group.options.map((option) => ({ public_id: option.id, name: option.name, price_delta: option.price_delta, sort_order: option.sort_order })),
  })) : modifierGroups;
  return {
    ...product,
    category: product.category_id ? { id: product.category_id, slug: product.category_slug, name: product.category_name } : null,
    fulfillment_modes: fulfillment.rows.map((row) => row.mode),
    variants: safeVariants,
    media: safeMedia,
    modifier_groups: safeModifierGroups,
    ...(publicOnly ? { availability: {
      in_stock: !inventoryRows.some((row) => row.track_inventory) || inventoryRows.some((row) => row.track_inventory && row.available > 0),
      inventory_tracked: inventoryRows.some((row) => row.track_inventory),
    } } : { inventory: inventoryRows }),
  };
}
