import { errors } from '../../../core/errors.js';
import { productDetails, resolveStore } from '../../catalog/service.js';
import { orderDetails } from '../../orders/service.js';
import { paymentDetails } from '../../payments/service.js';
import { fulfillmentDetails } from '../../delivery/service.js';
import { getCustomerServicePolicy, isToolAllowed } from './policy.js';
import { signServiceAccessToken } from '../../../core/tokens.js';

const CAPABILITIES = Object.freeze({
  'customer.read': true,
  'product.read': true,
  'orders.read': true,
  'order_status.read': true,
  'payments.read': true,
  'delivery.read': true,
  'digital.read': false,
  'orders.cancel': false,
  'refunds.create': false,
});

async function accessLog(app, request, action, resultCode, targetType = null, targetRef = null) {
  await app.db.query(
    `INSERT INTO customer_service_access_logs(
       tenant_id, integration_client_id, action, target_type, target_ref, result_code, request_id, request_ip
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [request.serviceAuth.tenantId, request.serviceAuth.clientId, action, targetType, targetRef, resultCode, request.id, request.ip || null],
  );
}

export async function customerServiceRoutes(app) {
  app.post('/v1/customer-service/auth/token', {
    preHandler: [app.requireCustomerServiceAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request) => {
    if (request.serviceAuth.authMode !== 'CREDENTIAL') throw errors.unauthorized('SERVICE_CREDENTIAL_REQUIRED', 'Long-lived service credential required to mint a signed service token');
    const signed = await signServiceAccessToken(app.config, {
      clientId: request.serviceAuth.clientId, tenantId: request.serviceAuth.tenantId, usageMode: request.serviceAuth.usageMode,
    });
    await accessLog(app, request, 'service.token.issue', 'SUCCESS', 'integration_client', request.serviceAuth.clientPublicId);
    return { data: { access_token: signed.token, token_type: 'Bearer', expires_in: signed.expiresIn, usage_mode: request.serviceAuth.usageMode } };
  });

  app.get('/v1/customer-service/health', {
    preHandler: [app.requireCustomerServiceAuth],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    await accessLog(app, request, 'health', 'SUCCESS');
    return { data: { status: 'ok', api_version: '2', backend_release: app.config.release,
      tenant: { id: request.serviceAuth.tenantPublicId, slug: request.serviceAuth.tenantSlug } } };
  });

  app.get('/v1/customer-service/capabilities', {
    preHandler: [app.requireCustomerServiceAuth],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    await accessLog(app, request, 'capabilities', 'SUCCESS');
    const policy = await getCustomerServicePolicy(app.db, request.serviceAuth.tenantId);
    const toolForScope = { 'customer.read':'customer.get','product.read':'product.get','orders.read':'orders.list','order_status.read':'order.status','payments.read':'payment.status','delivery.read':'delivery.status' };
    const permitted = Object.fromEntries(Object.entries(CAPABILITIES).map(([key, available]) => {
      if (!available || !request.serviceAuth.scopes.includes(key)) return [key, false];
      const tool = toolForScope[key]; return [key, tool ? isToolAllowed(policy, request.serviceAuth.usageMode, tool) : false];
    }));
    return { data: { api_version: '2', capabilities: permitted, granted_scopes: request.serviceAuth.scopes, usage_mode: request.serviceAuth.usageMode, tool_gateway: '/v1/customer-service/tools/execute' } };
  });

  app.get('/v1/customer-service/customers/:customerId', {
    preHandler: [app.requireCustomerServiceAuth, app.requireServiceScope('customer.read')],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    const result = await app.db.query(
      `SELECT public_id, display_name, status, created_at, last_login_at
         FROM customers WHERE tenant_id = $1 AND public_id = $2`,
      [request.serviceAuth.tenantId, request.params.customerId],
    );
    if (!result.rowCount) {
      await accessLog(app, request, 'customer.read', 'NOT_FOUND', 'customer', request.params.customerId);
      throw errors.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
    }
    await accessLog(app, request, 'customer.read', 'SUCCESS', 'customer', request.params.customerId);
    return { data: { customer: result.rows[0] } };
  });

  app.get('/v1/customer-service/products', {
    preHandler: [app.requireCustomerServiceAuth, app.requireServiceScope('product.read')],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['q'], properties: {
      q: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
    } } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.serviceAuth.tenantId, request.headers['x-store-id'] || null);
    const result = await app.db.query(
      `SELECT p.public_id,p.slug,p.name,p.short_description,p.product_type,p.base_price,p.currency,
              (SELECT m.url FROM product_media m WHERE m.tenant_id=p.tenant_id AND m.store_id=p.store_id AND m.product_id=p.id
                AND m.visibility='PUBLIC' AND m.status='ACTIVE' ORDER BY m.is_primary DESC,m.sort_order,m.created_at LIMIT 1) AS primary_media_url
         FROM products p
        WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.status='PUBLISHED'
          AND (p.name ILIKE '%'||$3||'%' OR p.slug ILIKE '%'||$3||'%' OR COALESCE(p.short_description,'') ILIKE '%'||$3||'%')
        ORDER BY CASE WHEN lower(p.name)=lower($3) THEN 0 ELSE 1 END,p.name LIMIT $4`,
      [request.serviceAuth.tenantId, store.id, request.query.q, request.query.limit || 10],
    );
    await accessLog(app, request, 'product.search', 'SUCCESS', 'product', request.query.q);
    return { data: { products: result.rows } };
  });

  app.get('/v1/customer-service/products/:productRef', {
    preHandler: [app.requireCustomerServiceAuth, app.requireServiceScope('product.read')],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.serviceAuth.tenantId, request.headers['x-store-id'] || null);
    const found = await app.db.query(
      `SELECT id FROM products WHERE tenant_id=$1 AND store_id=$2 AND status='PUBLISHED' AND (public_id=$3 OR slug=$3) LIMIT 1`,
      [request.serviceAuth.tenantId, store.id, request.params.productRef],
    );
    if (!found.rowCount) {
      await accessLog(app, request, 'product.read', 'NOT_FOUND', 'product', request.params.productRef);
      throw errors.notFound('PRODUCT_NOT_FOUND', 'Product not found');
    }
    const product = await productDetails(app.db, request.serviceAuth.tenantId, store.id, found.rows[0].id, { publicOnly: true });
    await accessLog(app, request, 'product.read', 'SUCCESS', 'product', request.params.productRef);
    return { data: { product } };
  });

  app.get('/v1/customer-service/customers/:customerId/orders', {
    preHandler: [app.requireCustomerServiceAuth, app.requireServiceScope('orders.read')],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    } } },
  }, async (request) => {
    const customer = await app.db.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND public_id=$2`,
      [request.serviceAuth.tenantId, request.params.customerId],
    );
    if (!customer.rowCount) {
      await accessLog(app, request, 'orders.read', 'NOT_FOUND', 'customer', request.params.customerId);
      throw errors.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
    }
    const result = await app.db.query(
      `SELECT o.public_id AS id,o.order_number,o.order_type,o.status,o.payment_status,o.currency,o.grand_total,o.created_at,o.updated_at
         FROM orders o
        WHERE o.tenant_id=$1 AND o.customer_id=$2
        ORDER BY o.created_at DESC LIMIT $3`,
      [request.serviceAuth.tenantId, customer.rows[0].id, request.query.limit || 10],
    );
    await accessLog(app, request, 'orders.read', 'SUCCESS', 'customer', request.params.customerId);
    return { data: { customer_id: request.params.customerId, orders: result.rows } };
  });

  app.get('/v1/customer-service/customers/:customerId/orders/:orderRef', {
    preHandler: [app.requireCustomerServiceAuth, app.requireServiceScope('orders.read')],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    const customer = await app.db.query(
      `SELECT id FROM customers WHERE tenant_id=$1 AND public_id=$2`,
      [request.serviceAuth.tenantId, request.params.customerId],
    );
    if (!customer.rowCount) {
      await accessLog(app, request, 'orders.read', 'NOT_FOUND', 'customer', request.params.customerId);
      throw errors.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
    }
    try {
      const order = await orderDetails(app.db, request.serviceAuth.tenantId, request.params.orderRef, { customerId: customer.rows[0].id, publicSafe: true });
      await accessLog(app, request, 'orders.read', 'SUCCESS', 'order', request.params.orderRef);
      return { data: { order } };
    } catch (error) {
      if (error?.code === 'ORDER_NOT_FOUND') await accessLog(app, request, 'orders.read', 'NOT_FOUND', 'order', request.params.orderRef);
      throw error;
    }
  });

  app.get('/v1/customer-service/customers/:customerId/orders/:orderRef/status', {
    preHandler: [app.requireCustomerServiceAuth, app.requireServiceScope('order_status.read')],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    const result = await app.db.query(
      `SELECT o.public_id AS id,o.order_number,c.public_id AS customer_id,o.order_type,o.status,o.payment_status,
              o.currency,o.grand_total,o.created_at,o.updated_at,o.paid_at,o.cancelled_at,o.completed_at
         FROM orders o JOIN customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
        WHERE o.tenant_id=$1 AND c.public_id=$2 AND (o.public_id=$3 OR o.order_number=$3) LIMIT 1`,
      [request.serviceAuth.tenantId, request.params.customerId, request.params.orderRef],
    );
    if (!result.rowCount) {
      await accessLog(app, request, 'order_status.read', 'NOT_FOUND', 'order', request.params.orderRef);
      throw errors.notFound('ORDER_NOT_FOUND', 'Order not found for customer');
    }
    await accessLog(app, request, 'order_status.read', 'SUCCESS', 'order', request.params.orderRef);
    return { data: { order: result.rows[0] } };
  });

  app.get('/v1/customer-service/customers/:customerId/orders/:orderRef/payment', {
    preHandler: [app.requireCustomerServiceAuth, app.requireServiceScope('payments.read')],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    const customer = await app.db.query(`SELECT id FROM customers WHERE tenant_id=$1 AND public_id=$2`, [request.serviceAuth.tenantId, request.params.customerId]);
    if (!customer.rowCount) { await accessLog(app, request, 'payments.read', 'NOT_FOUND', 'customer', request.params.customerId); throw errors.notFound('CUSTOMER_NOT_FOUND', 'Customer not found'); }
    try {
      const payment = await paymentDetails(app.db, request.serviceAuth.tenantId, request.params.orderRef, { customerId: customer.rows[0].id });
      delete payment.customer_reference; delete payment.provider_reference; delete payment.failure_message; payment.attempts = [];
      await accessLog(app, request, 'payments.read', 'SUCCESS', 'order', request.params.orderRef);
      return { data: { payment } };
    } catch (error) { if (error?.code === 'PAYMENT_NOT_FOUND') await accessLog(app, request, 'payments.read', 'NOT_FOUND', 'order', request.params.orderRef); throw error; }
  });

  app.get('/v1/customer-service/customers/:customerId/orders/:orderRef/delivery', {
    preHandler: [app.requireCustomerServiceAuth, app.requireServiceScope('delivery.read')],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    const customer = await app.db.query(`SELECT id FROM customers WHERE tenant_id=$1 AND public_id=$2`, [request.serviceAuth.tenantId, request.params.customerId]);
    if (!customer.rowCount) { await accessLog(app, request, 'delivery.read', 'NOT_FOUND', 'customer', request.params.customerId); throw errors.notFound('CUSTOMER_NOT_FOUND', 'Customer not found'); }
    const fulfillments = await fulfillmentDetails(app.db, request.serviceAuth.tenantId, request.params.orderRef, { customerId: customer.rows[0].id });
    const safe = fulfillments.map(({ tracking_url, ...row }) => row);
    await accessLog(app, request, 'delivery.read', 'SUCCESS', 'order', request.params.orderRef);
    return { data: { fulfillments: safe } };
  });

}
