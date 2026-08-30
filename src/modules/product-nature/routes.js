import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { productDetails, resolveProduct, resolveStore } from '../catalog/service.js';
import { assertProductFulfillmentCompatibility, productFulfillmentPolicy, isDigitalProductType } from '../catalog/product-policy.js';
import { cartDetails } from '../orders/service.js';

const PRODUCT_TYPES = ['PHYSICAL','FOOD','DIGITAL_IMAGE','DIGITAL_VIDEO','SERVICE'];
const ACCESS_MODES = ['VIEW_ONLY','DOWNLOAD_ONLY','VIEW_AND_DOWNLOAD'];
const storeHeader = (request) => request.headers['x-store-id'] || null;

function digitalFulfillmentMode(accessMode) {
  return accessMode === 'DOWNLOAD_ONLY' ? 'DIGITAL_DOWNLOAD' : 'DIGITAL_ACCESS';
}

function modesForNature(productType, body = {}) {
  const policy = productFulfillmentPolicy(productType);
  if (isDigitalProductType(productType)) {
    return [digitalFulfillmentMode(body.access_mode || 'VIEW_ONLY')];
  }
  if (productType === 'SERVICE') return ['NONE'];
  const requested = Array.isArray(body.fulfillment_modes) && body.fulfillment_modes.length
    ? body.fulfillment_modes
    : policy.defaultModes;
  return assertProductFulfillmentCompatibility(productType, requested);
}

async function repairProductInActiveCarts(client, { tenantId, storeId, productId, allowedModes, fallbackMode }) {
  const repaired = await client.query(
    `UPDATE cart_items ci
        SET fulfillment_mode=$1,updated_at=now()
       FROM carts c
      WHERE c.id=ci.cart_id AND c.tenant_id=ci.tenant_id AND c.store_id=ci.store_id
        AND ci.tenant_id=$2 AND ci.store_id=$3 AND ci.product_id=$4 AND c.status='ACTIVE'
        AND NOT (ci.fulfillment_mode = ANY($5::text[]))
      RETURNING ci.public_id`,
    [fallbackMode, tenantId, storeId, productId, allowedModes],
  );
  if (repaired.rowCount) {
    await client.query(
      `UPDATE carts c SET updated_at=now()
        WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.status='ACTIVE'
          AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id=c.id AND ci.public_id = ANY($3::text[]))`,
      [tenantId, storeId, repaired.rows.map((row) => row.public_id)],
    );
  }
  return repaired.rowCount;
}

async function repairActiveCart(client, { tenantId, storeId, customerId }) {
  const cart = await client.query(
    `SELECT * FROM carts WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND status='ACTIVE' FOR UPDATE`,
    [tenantId, storeId, customerId],
  );
  if (!cart.rowCount) return { cartPublicId: null, repairedItems: 0 };

  const items = await client.query(
    `SELECT ci.id,ci.public_id,ci.fulfillment_mode,p.product_type,
            ARRAY(SELECT pfm.mode FROM product_fulfillment_modes pfm
                   WHERE pfm.tenant_id=ci.tenant_id AND pfm.store_id=ci.store_id AND pfm.product_id=ci.product_id
                   ORDER BY pfm.mode) AS available_modes
       FROM cart_items ci
       JOIN products p ON p.id=ci.product_id AND p.tenant_id=ci.tenant_id AND p.store_id=ci.store_id
      WHERE ci.tenant_id=$1 AND ci.store_id=$2 AND ci.cart_id=$3
      ORDER BY ci.created_at,ci.id
      FOR UPDATE OF ci`,
    [tenantId, storeId, cart.rows[0].id],
  );

  let repairedItems = 0;
  for (const item of items.rows) {
    const available = Array.isArray(item.available_modes) ? item.available_modes : [];
    if (!available.length || available.includes(item.fulfillment_mode)) continue;
    const policy = productFulfillmentPolicy(item.product_type);
    const fallback = policy.defaultModes.find((mode) => available.includes(mode)) || available[0];
    await client.query('UPDATE cart_items SET fulfillment_mode=$1,updated_at=now() WHERE id=$2', [fallback, item.id]);
    repairedItems += 1;
  }
  if (repairedItems) await client.query('UPDATE carts SET updated_at=now() WHERE id=$1', [cart.rows[0].id]);
  return { cartPublicId: cart.rows[0].public_id, repairedItems };
}

export async function productNatureRoutes(app) {
  app.put('/v1/merchant/products/:productId/nature', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CATALOG_WRITE)],
    schema: { body: { type:'object', additionalProperties:false, required:['product_type'], properties: {
      product_type: { type:'string', enum:PRODUCT_TYPES },
      fulfillment_modes: { type:'array', minItems:1, maxItems:3, uniqueItems:true, items:{ type:'string', enum:['SHIPPING','LOCAL_DELIVERY','PICKUP'] } },
      access_mode: { type:'string', enum:ACCESS_MODES },
      download_limit: { anyOf:[{ type:'integer', minimum:0, maximum:100000 },{ type:'null' }] },
    } } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request), { requireActive:false });
    const result = await app.db.transaction(async (client) => {
      const current = await resolveProduct(client, request.auth.tenantId, store.id, request.params.productId, { forUpdate:true });
      const targetType = request.body.product_type;
      const changingType = current.product_type !== targetType;
      if (changingType) {
        const history = await client.query(
          'SELECT count(*)::int AS count FROM order_items WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3',
          [request.auth.tenantId, store.id, current.id],
        );
        if (history.rows[0].count > 0) {
          throw errors.conflict('PRODUCT_NATURE_CHANGE_HAS_ORDER_HISTORY', 'Product nature cannot change after the product has order history');
        }
      }

      const modes = modesForNature(targetType, request.body);
      const fallbackMode = modes[0];
      await client.query('DELETE FROM product_fulfillment_modes WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3', [request.auth.tenantId, store.id, current.id]);
      await client.query(
        `UPDATE products SET product_type=$1,
          track_inventory=CASE WHEN $1 IN ('DIGITAL_IMAGE','DIGITAL_VIDEO','SERVICE') THEN false ELSE track_inventory END,
          updated_at=now()
         WHERE tenant_id=$2 AND store_id=$3 AND id=$4`,
        [targetType, request.auth.tenantId, store.id, current.id],
      );
      for (const mode of modes) {
        await client.query('INSERT INTO product_fulfillment_modes(tenant_id,store_id,product_id,mode) VALUES($1,$2,$3,$4)', [request.auth.tenantId, store.id, current.id, mode]);
      }

      if (isDigitalProductType(targetType)) {
        const accessMode = request.body.access_mode || 'VIEW_ONLY';
        await client.query(
          `INSERT INTO product_digital_policies(tenant_id,store_id,product_id,access_mode,download_limit,updated_at)
           VALUES($1,$2,$3,$4,$5,now())
           ON CONFLICT (tenant_id,store_id,product_id) DO UPDATE SET access_mode=EXCLUDED.access_mode,download_limit=EXCLUDED.download_limit,updated_at=now()`,
          [request.auth.tenantId, store.id, current.id, accessMode, request.body.download_limit ?? null],
        );
      } else {
        await client.query('DELETE FROM product_digital_policies WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3', [request.auth.tenantId, store.id, current.id]);
      }
      if (['DIGITAL_IMAGE','DIGITAL_VIDEO','SERVICE'].includes(targetType)) {
        await client.query('UPDATE inventory_items SET track_inventory=false,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3', [request.auth.tenantId, store.id, current.id]);
        await client.query('UPDATE product_variants SET track_inventory=false,updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3', [request.auth.tenantId, store.id, current.id]);
      }

      const repairedCartItems = await repairProductInActiveCarts(client, {
        tenantId:request.auth.tenantId, storeId:store.id, productId:current.id, allowedModes:modes, fallbackMode,
      });
      await writeAudit(client, {
        tenantId:request.auth.tenantId, actorType:'MERCHANT', actorId:request.auth.actorId,
        action:'catalog.product.nature_change', targetType:'product', targetId:current.id,
        metadata:{ from_type:current.product_type, to_type:targetType, fulfillment_modes:modes,
          access_mode:isDigitalProductType(targetType)?request.body.access_mode||'VIEW_ONLY':null,
          repaired_active_cart_items:repairedCartItems }, requestIp:request.ip, requestId:request.id,
      });
      return { productId:current.id, fromType:current.product_type, toType:targetType, modes, repairedCartItems };
    });
    return { data:{ product:await productDetails(app.db, request.auth.tenantId, store.id, result.productId), conversion:{
      from_type:result.fromType,to_type:result.toType,fulfillment_modes:result.modes,repaired_active_cart_items:result.repairedCartItems,
    } } };
  });

  app.post('/v1/customer/cart/repair', {
    preHandler: [app.requireCustomerAuth],
    schema: { body:{ type:'object', additionalProperties:false, properties:{} } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const result = await app.db.transaction(async (client) => repairActiveCart(client, {
      tenantId:request.auth.tenantId, storeId:store.id, customerId:request.auth.actorId,
    }));
    const cart = result.cartPublicId
      ? await cartDetails(app.db, request.auth.tenantId, store.id, request.auth.actorId, result.cartPublicId)
      : null;
    return { data:{ cart, repaired_items:result.repairedItems } };
  });
}
