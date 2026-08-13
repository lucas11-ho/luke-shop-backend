import { randomBytes } from 'node:crypto';
import { errors } from '../../core/errors.js';

const FULFILLMENT_MODES = new Set(['SHIPPING','LOCAL_DELIVERY','PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','NONE']);

const TRANSITIONS = Object.freeze({
  PHYSICAL: {
    PENDING_PAYMENT: ['PAID','PAYMENT_FAILED','CANCELLED'],
    PAYMENT_FAILED: ['PENDING_PAYMENT','CANCELLED'],
    PAID: ['CONFIRMED','REFUND_PENDING'],
    CONFIRMED: ['PROCESSING','REFUND_PENDING'],
    PROCESSING: ['PACKED','REFUND_PENDING'],
    PACKED: ['SHIPPED','PICKED_UP','REFUND_PENDING'],
    SHIPPED: ['OUT_FOR_DELIVERY','DELIVERED'],
    OUT_FOR_DELIVERY: ['DELIVERED'],
    PICKED_UP: ['COMPLETED'],
    DELIVERED: ['COMPLETED'],
    REFUND_PENDING: ['REFUNDED'],
  },
  FOOD: {
    PENDING_PAYMENT: ['PAID','PAYMENT_FAILED','CANCELLED'],
    PAYMENT_FAILED: ['PENDING_PAYMENT','CANCELLED'],
    PAID: ['RESTAURANT_ACCEPTED','REFUND_PENDING'],
    RESTAURANT_ACCEPTED: ['PREPARING','REFUND_PENDING'],
    PREPARING: ['READY','REFUND_PENDING'],
    READY: ['PICKED_UP','OUT_FOR_DELIVERY','DELIVERED'],
    PICKED_UP: ['COMPLETED'],
    OUT_FOR_DELIVERY: ['DELIVERED'],
    DELIVERED: ['COMPLETED'],
    REFUND_PENDING: ['REFUNDED'],
  },
  DIGITAL: {
    PENDING_PAYMENT: ['PAID','PAYMENT_FAILED','CANCELLED'],
    PAYMENT_FAILED: ['PENDING_PAYMENT','CANCELLED'],
    PAID: ['ACCESS_GRANTED','AVAILABLE_FOR_DOWNLOAD','REFUND_PENDING'],
    ACCESS_GRANTED: ['COMPLETED','REFUND_PENDING'],
    AVAILABLE_FOR_DOWNLOAD: ['COMPLETED','REFUND_PENDING'],
    REFUND_PENDING: ['REFUNDED'],
  },
  SERVICE: {
    PENDING_PAYMENT: ['PAID','PAYMENT_FAILED','CANCELLED'],
    PAYMENT_FAILED: ['PENDING_PAYMENT','CANCELLED'],
    PAID: ['CONFIRMED','PROCESSING','REFUND_PENDING'],
    CONFIRMED: ['PROCESSING','COMPLETED','REFUND_PENDING'],
    PROCESSING: ['COMPLETED','REFUND_PENDING'],
    REFUND_PENDING: ['REFUNDED'],
  },
  MIXED: {
    PENDING_PAYMENT: ['PAID','PAYMENT_FAILED','CANCELLED'],
    PAYMENT_FAILED: ['PENDING_PAYMENT','CANCELLED'],
    PAID: ['CONFIRMED','REFUND_PENDING'],
    CONFIRMED: ['PROCESSING','REFUND_PENDING'],
    PROCESSING: ['PACKED','COMPLETED','REFUND_PENDING'],
    PACKED: ['SHIPPED','PICKED_UP','COMPLETED','REFUND_PENDING'],
    SHIPPED: ['OUT_FOR_DELIVERY','DELIVERED'],
    OUT_FOR_DELIVERY: ['DELIVERED'],
    PICKED_UP: ['COMPLETED'],
    DELIVERED: ['COMPLETED'],
    REFUND_PENDING: ['REFUNDED'],
  },
});

export function makeOrderNumber(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `LS${stamp}${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function orderTypeFor(productTypes) {
  const values = [...new Set(productTypes)];
  if (values.length !== 1) return 'MIXED';
  if (values[0] === 'FOOD') return 'FOOD';
  if (values[0] === 'DIGITAL_IMAGE' || values[0] === 'DIGITAL_VIDEO') return 'DIGITAL';
  if (values[0] === 'SERVICE') return 'SERVICE';
  return 'PHYSICAL';
}

export function allowedOrderTransitions(orderType, fromStatus) {
  return [...(TRANSITIONS[orderType]?.[fromStatus] || [])];
}

export function assertOrderTransition(orderType, fromStatus, toStatus) {
  const allowed = TRANSITIONS[orderType]?.[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw errors.conflict('ORDER_TRANSITION_INVALID', `Order status cannot transition from ${fromStatus} to ${toStatus}`);
  }
}

export function paymentStatusFor(orderStatus, previous = 'PENDING') {
  if (orderStatus === 'PAID') return 'PAID';
  if (orderStatus === 'PAYMENT_FAILED') return 'FAILED';
  if (orderStatus === 'REFUND_PENDING') return 'REFUND_PENDING';
  if (orderStatus === 'REFUNDED') return 'REFUNDED';
  return previous;
}

export function assertFulfillmentMode(mode) {
  if (!FULFILLMENT_MODES.has(mode)) throw errors.badRequest('FULFILLMENT_MODE_INVALID', 'Unsupported fulfillment mode');
}

export function money(value) {
  return Number(Number(value || 0).toFixed(4));
}

export async function getOrCreateActiveCart(client, { tenantId, store, customerId, publicId, uuid }) {
  const existing = await client.query(
    `SELECT * FROM carts WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND status='ACTIVE' FOR UPDATE`,
    [tenantId, store.id, customerId],
  );
  if (existing.rowCount) return existing.rows[0];
  const created = await client.query(
    `INSERT INTO carts(id,public_id,tenant_id,store_id,customer_id,status,currency)
     VALUES($1,$2,$3,$4,$5,'ACTIVE',$6) RETURNING *`,
    [uuid(), publicId('cart'), tenantId, store.id, customerId, store.currency],
  );
  return created.rows[0];
}

export async function cartDetails(db, tenantId, storeId, customerId, cartPublicId = null) {
  const values = [tenantId, storeId, customerId];
  let where = `tenant_id=$1 AND store_id=$2 AND customer_id=$3`;
  if (cartPublicId) { values.push(cartPublicId); where += ` AND public_id=$${values.length}`; }
  else where += ` AND status='ACTIVE'`;
  const cart = await db.query(`SELECT id,public_id,status,currency,expires_at,created_at,updated_at FROM carts WHERE ${where} ORDER BY created_at DESC LIMIT 1`, values);
  if (!cart.rowCount) return null;
  const items = await db.query(
    `SELECT ci.public_id, p.public_id AS product_id, p.slug AS product_slug, ci.variant_id AS variant_internal_id,
            v.public_id AS variant_id, ci.quantity, ci.fulfillment_mode, ci.title_snapshot, ci.variant_title_snapshot,
            ci.sku_snapshot, ci.unit_price, ci.modifier_total, ci.selected_modifiers, ci.line_total, ci.currency,
            (SELECT m.url FROM product_media m WHERE m.tenant_id=ci.tenant_id AND m.store_id=ci.store_id AND m.product_id=ci.product_id
              AND m.visibility='PUBLIC' AND m.status='ACTIVE' ORDER BY (m.variant_id=ci.variant_id) DESC,m.is_primary DESC,m.sort_order,m.created_at LIMIT 1) AS media_url
       FROM cart_items ci
       JOIN products p ON p.id=ci.product_id AND p.tenant_id=ci.tenant_id AND p.store_id=ci.store_id
       LEFT JOIN product_variants v ON v.id=ci.variant_id AND v.tenant_id=ci.tenant_id AND v.store_id=ci.store_id
      WHERE ci.tenant_id=$1 AND ci.store_id=$2 AND ci.cart_id=$3 ORDER BY ci.created_at,ci.id`,
    [tenantId, storeId, cart.rows[0].id],
  );
  const subtotal = money(items.rows.reduce((sum, row) => sum + Number(row.line_total), 0));
  return { ...cart.rows[0], items: items.rows.map(({ variant_internal_id, ...row }) => row), totals: { subtotal, discount_total: 0, delivery_total: 0, tax_total: 0, grand_total: subtotal } };
}

export async function validateCartItem(client, { tenantId, storeId, productRef, variantRef = null, quantity, fulfillmentMode, modifierOptionIds = [] }) {
  assertFulfillmentMode(fulfillmentMode);
  const productResult = await client.query(
    `SELECT id,public_id,slug,name,product_type,status,base_price,currency,track_inventory
       FROM products WHERE tenant_id=$1 AND store_id=$2 AND status='PUBLISHED' AND (public_id=$3 OR slug=$3)`,
    [tenantId, storeId, productRef],
  );
  if (!productResult.rowCount) throw errors.notFound('PRODUCT_NOT_FOUND', 'Published product not found');
  const product = productResult.rows[0];
  const modeResult = await client.query(
    `SELECT 1 FROM product_fulfillment_modes WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND mode=$4`,
    [tenantId, storeId, product.id, fulfillmentMode],
  );
  if (!modeResult.rowCount) throw errors.badRequest('FULFILLMENT_MODE_NOT_AVAILABLE', 'Selected fulfillment mode is not available for this product');

  let variant = null;
  if (variantRef) {
    const result = await client.query(
      `SELECT id,public_id,title,sku,attributes,price_override,track_inventory,status FROM product_variants
        WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND public_id=$4 AND status='ACTIVE'`,
      [tenantId, storeId, product.id, variantRef],
    );
    if (!result.rowCount) throw errors.notFound('VARIANT_NOT_FOUND', 'Active product variant not found');
    variant = result.rows[0];
  } else {
    const activeVariants = await client.query(
      `SELECT count(*)::int AS count FROM product_variants WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND status='ACTIVE'`,
      [tenantId, storeId, product.id],
    );
    if (activeVariants.rows[0].count > 0) throw errors.badRequest('VARIANT_REQUIRED', 'A product variant must be selected');
  }

  const groups = await client.query(
    `SELECT id,public_id,name,required,min_selections,max_selections FROM product_modifier_groups
      WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 AND status='ACTIVE' ORDER BY sort_order,created_at`,
    [tenantId, storeId, product.id],
  );
  const uniqueOptionIds = [...new Set(modifierOptionIds)];
  let options = [];
  if (uniqueOptionIds.length) {
    const optionResult = await client.query(
      `SELECT o.id,o.public_id,o.group_id,g.public_id AS group_public_id,g.name AS group_name,o.name,o.price_delta
         FROM product_modifier_options o
         JOIN product_modifier_groups g ON g.id=o.group_id AND g.tenant_id=o.tenant_id AND g.store_id=o.store_id AND g.product_id=o.product_id
        WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.product_id=$3 AND o.status='ACTIVE' AND g.status='ACTIVE' AND o.public_id = ANY($4::text[])`,
      [tenantId, storeId, product.id, uniqueOptionIds],
    );
    if (optionResult.rowCount !== uniqueOptionIds.length) throw errors.badRequest('MODIFIER_OPTION_INVALID', 'One or more modifier options are invalid');
    options = optionResult.rows;
  }
  for (const group of groups.rows) {
    const selected = options.filter((option) => option.group_id === group.id).length;
    if (selected < group.min_selections || selected > group.max_selections || (group.required && selected === 0)) {
      throw errors.badRequest('MODIFIER_SELECTION_INVALID', `Modifier selection rules were not satisfied for ${group.name}`);
    }
  }
  const unitPrice = money(variant?.price_override ?? product.base_price);
  const modifierTotal = money(options.reduce((sum, option) => sum + Number(option.price_delta), 0));
  const lineTotal = money((unitPrice + modifierTotal) * quantity);
  return {
    product, variant, unitPrice, modifierTotal, lineTotal,
    selectedModifiers: options.map((option) => ({ id: option.public_id, group_id: option.group_public_id, group_name: option.group_name, name: option.name, price_delta: money(option.price_delta) })),
  };
}

export async function orderDetails(db, tenantId, orderId, { customerId = null, publicSafe = false } = {}) {
  const values = [tenantId, orderId];
  let owner = '';
  if (customerId) { values.push(customerId); owner = ` AND o.customer_id=$${values.length}`; }
  const order = await db.query(
    `SELECT o.*,s.public_id AS store_public_id,s.name AS store_name,c.public_id AS customer_public_id,c.display_name AS customer_display_name
       FROM orders o JOIN stores s ON s.id=o.store_id AND s.tenant_id=o.tenant_id
       JOIN customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
      WHERE o.tenant_id=$1 AND (o.public_id=$2 OR o.order_number=$2)${owner} LIMIT 1`, values,
  );
  if (!order.rowCount) throw errors.notFound('ORDER_NOT_FOUND', 'Order not found');
  const row = order.rows[0];
  const [items, history, address, payment, fulfillments, adjustments] = await Promise.all([
    db.query(`SELECT oi.public_id,p.public_id AS product_id,p.slug AS product_slug,v.public_id AS variant_id,oi.quantity,oi.fulfillment_mode,
      oi.title_snapshot,oi.variant_title_snapshot,oi.sku_snapshot,oi.unit_price,oi.modifier_total,oi.selected_modifiers,oi.line_total,oi.currency
      FROM order_items oi JOIN products p ON p.id=oi.product_id AND p.tenant_id=oi.tenant_id AND p.store_id=oi.store_id
      LEFT JOIN product_variants v ON v.id=oi.variant_id AND v.tenant_id=oi.tenant_id AND v.store_id=oi.store_id
      WHERE oi.tenant_id=$1 AND oi.store_id=$2 AND oi.order_id=$3 ORDER BY oi.created_at,oi.id`, [tenantId,row.store_id,row.id]),
    db.query(`SELECT from_status,to_status,reason,actor_type,created_at FROM order_status_history WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY created_at,id`, [tenantId,row.store_id,row.id]),
    publicSafe ? Promise.resolve({ rowCount: 0, rows: [] }) : db.query(`SELECT recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note FROM order_addresses WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`, [tenantId,row.store_id,row.id]),
    db.query(`SELECT op.public_id AS id,op.status,op.amount,op.currency,pm.public_id AS payment_method_id,pm.code AS payment_method_code,pm.name AS payment_method_name,pm.provider_type,${publicSafe ? 'NULL::text' : 'op.provider_reference'} AS provider_reference,op.paid_at,op.failed_at,op.refunded_amount FROM order_payments op LEFT JOIN payment_methods pm ON pm.id=op.payment_method_id AND pm.tenant_id=op.tenant_id AND pm.store_id=op.store_id WHERE op.tenant_id=$1 AND op.store_id=$2 AND op.order_id=$3`, [tenantId,row.store_id,row.id]),
    db.query(`SELECT f.public_id AS id,f.fulfillment_mode,f.status,f.fee,dm.public_id AS delivery_method_id,dm.code AS delivery_method_code,dm.name AS delivery_method_name,f.carrier,${publicSafe ? 'NULL::text' : 'f.tracking_number'} AS tracking_number,${publicSafe ? 'NULL::text' : 'f.tracking_url'} AS tracking_url,f.estimated_at,f.shipped_at,f.delivered_at FROM order_fulfillments f LEFT JOIN delivery_methods dm ON dm.id=f.delivery_method_id AND dm.tenant_id=f.tenant_id AND dm.store_id=f.store_id WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.order_id=$3 ORDER BY f.created_at`, [tenantId,row.store_id,row.id]),
    db.query(`SELECT adjustment_type,code,description,amount,created_at FROM order_adjustments WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY created_at,id`, [tenantId,row.store_id,row.id]),
  ]);
  const safe = {
    id: row.public_id, order_number: row.order_number, store: { id: row.store_public_id, name: row.store_name },
    customer: { id: row.customer_public_id, display_name: row.customer_display_name }, order_type: row.order_type,
    status: row.status, payment_status: row.payment_status, currency: row.currency, subtotal: row.subtotal,
    discount_total: row.discount_total, delivery_total: row.delivery_total, tax_total: row.tax_total, grand_total: row.grand_total,
    customer_note: row.customer_note, created_at: row.created_at, paid_at: row.paid_at, cancelled_at: row.cancelled_at, completed_at: row.completed_at,
    items: items.rows, status_history: history.rows, payment: payment.rowCount ? payment.rows[0] : null, fulfillments: fulfillments.rows, adjustments: adjustments.rows,
  };
  if (!publicSafe) safe.shipping_address = address.rowCount ? address.rows[0] : null;
  return safe;
}

export async function releaseReservations(client, { tenantId, storeId, orderId, requestId }) {
  const reservations = await client.query(
    `SELECT r.*,b.on_hand,b.reserved FROM inventory_reservations r
     JOIN inventory_balances b ON b.tenant_id=r.tenant_id AND b.store_id=r.store_id AND b.inventory_item_id=r.inventory_item_id AND b.location_id=r.location_id
     WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.order_id=$3 AND r.status='ACTIVE' FOR UPDATE OF b,r`,
    [tenantId,storeId,orderId],
  );
  for (const reservation of reservations.rows) {
    const nextReserved = Number(reservation.reserved) - Number(reservation.quantity);
    if (nextReserved < 0) throw errors.conflict('INVENTORY_RESERVATION_CORRUPT', 'Inventory reservation balance is inconsistent');
    await client.query(`UPDATE inventory_balances SET reserved=$1,updated_at=now() WHERE tenant_id=$2 AND store_id=$3 AND inventory_item_id=$4 AND location_id=$5`, [nextReserved,tenantId,storeId,reservation.inventory_item_id,reservation.location_id]);
    await client.query(`UPDATE inventory_reservations SET status='RELEASED',released_at=now() WHERE id=$1`, [reservation.id]);
    await client.query(`INSERT INTO inventory_ledger(tenant_id,store_id,inventory_item_id,location_id,movement_type,on_hand_delta,reserved_delta,on_hand_after,reserved_after,reason,reference_type,reference_id,actor_type,request_id)
      VALUES($1,$2,$3,$4,'RELEASE',0,$5,$6,$7,'Order reservation released','ORDER',$8,'SYSTEM',$9)`, [tenantId,storeId,reservation.inventory_item_id,reservation.location_id,-Number(reservation.quantity),Number(reservation.on_hand),nextReserved,String(orderId),requestId]);
  }
}

export async function consumeReservations(client, { tenantId, storeId, orderId, requestId }) {
  const reservations = await client.query(
    `SELECT r.*,b.on_hand,b.reserved FROM inventory_reservations r
     JOIN inventory_balances b ON b.tenant_id=r.tenant_id AND b.store_id=r.store_id AND b.inventory_item_id=r.inventory_item_id AND b.location_id=r.location_id
     WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.order_id=$3 AND r.status='ACTIVE' FOR UPDATE OF b,r`,
    [tenantId,storeId,orderId],
  );
  for (const reservation of reservations.rows) {
    const qty = Number(reservation.quantity); const nextOnHand = Number(reservation.on_hand) - qty; const nextReserved = Number(reservation.reserved) - qty;
    if (nextOnHand < 0 || nextReserved < 0 || nextReserved > nextOnHand) throw errors.conflict('INVENTORY_RESERVATION_CORRUPT', 'Inventory reservation cannot be consumed safely');
    await client.query(`UPDATE inventory_balances SET on_hand=$1,reserved=$2,updated_at=now() WHERE tenant_id=$3 AND store_id=$4 AND inventory_item_id=$5 AND location_id=$6`, [nextOnHand,nextReserved,tenantId,storeId,reservation.inventory_item_id,reservation.location_id]);
    await client.query(`UPDATE inventory_reservations SET status='CONSUMED',consumed_at=now() WHERE id=$1`, [reservation.id]);
    await client.query(`INSERT INTO inventory_ledger(tenant_id,store_id,inventory_item_id,location_id,movement_type,on_hand_delta,reserved_delta,on_hand_after,reserved_after,reason,reference_type,reference_id,actor_type,request_id)
      VALUES($1,$2,$3,$4,'SALE',$5,$6,$7,$8,'Order inventory consumed','ORDER',$9,'SYSTEM',$10)`, [tenantId,storeId,reservation.inventory_item_id,reservation.location_id,-qty,-qty,nextOnHand,nextReserved,String(orderId),requestId]);
  }
}
