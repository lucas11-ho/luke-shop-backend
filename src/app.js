import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AppError, normalizeHttpClientError } from './core/errors.js';
import { createDatabase } from './db/pool.js';
import { tenantPlugin } from './plugins/tenant.js';
import { authPlugin } from './plugins/auth.js';
import { customerServiceAuthPlugin } from './modules/integrations/customer-service/service-auth.js';
import { healthRoutes } from './modules/health/routes.js';
import { storefrontRoutes } from './modules/storefront/routes.js';
import { customerAuthRoutes } from './modules/auth/customer-routes.js';
import { merchantAuthRoutes } from './modules/auth/merchant-routes.js';
import { merchantTenantRoutes } from './modules/merchant/tenant-routes.js';
import { merchantCustomerRoutes } from './modules/merchant/customer-routes.js';
import { merchantAccessRoutes } from './modules/merchant/access-routes.js';
import { merchantCatalogRoutes } from './modules/catalog/merchant-routes.js';
import { storefrontCatalogRoutes } from './modules/catalog/storefront-routes.js';
import { merchantInventoryRoutes } from './modules/inventory/merchant-routes.js';
import { customerOrderRoutes } from './modules/orders/customer-routes.js';
import { merchantOrderRoutes } from './modules/orders/merchant-routes.js';
import { merchantPaymentRoutes } from './modules/payments/merchant-routes.js';
import { merchantDeliveryRoutes } from './modules/delivery/merchant-routes.js';
import { merchantPromotionRoutes } from './modules/promotions/merchant-routes.js';
import { customerCommerceRoutes } from './modules/commerce/customer-routes.js';
import { customerServiceMerchantRoutes } from './modules/integrations/customer-service/merchant-routes.js';
import { customerServiceRoutes } from './modules/integrations/customer-service/service-routes.js';
import { customerSupportContextRoutes } from './modules/integrations/customer-service/customer-context-routes.js';
import { customerServiceToolRoutes } from './modules/integrations/customer-service/tool-routes.js';
import { platformAuthPlugin } from './modules/platform/auth.js';
import { platformAuthRoutes } from './modules/platform/auth-routes.js';
import { platformControlRoutes } from './modules/platform/control-routes.js';
import { merchantCustomerExperienceRoutes } from './modules/customer-experience/merchant-routes.js';
import { merchantAssetRoutes, publicAssetRoutes } from './modules/assets/routes.js';

export async function buildApp(config) {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: 15000,
    keepAliveTimeout: 72000,
    logController: new LogController({ disableRequestLogging: config.production }),
  });
  app.decorate('config', config);
  app.decorate('db', createDatabase(config));

  await app.register(helmet, { global: true });
  await app.register(rateLimit, { global: true, max: config.rateLimitMax, timeWindow: '1 minute' });
  await app.register(cors, {
    credentials: false,
    methods: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Authorization','Content-Type','X-Tenant-Slug','X-Store-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
    strictPreflight: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes(origin)) return callback(null, true);
      let parsed;
      try { parsed = new URL(origin); } catch { return callback(null, false); }
      const hostname = parsed.hostname.toLowerCase();
      const suffix = config.storefrontHostSuffix;
      if (suffix && (hostname === suffix || hostname.endsWith(`.${suffix}`))) return callback(null, true);
      app.db.query("SELECT 1 FROM storefront_domains WHERE hostname=$1 AND status='VERIFIED' LIMIT 1", [hostname])
        .then((result) => callback(null, result.rowCount > 0))
        .catch(() => callback(null, false));
    },
  });

  tenantPlugin(app);
  authPlugin(app);
  customerServiceAuthPlugin(app);
  platformAuthPlugin(app);

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message,
        ...(error.details ? { details: error.details } : {}), request_id: request.id } });
    }
    if (error.validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed',
        details: error.validation, request_id: request.id } });
    }
    if (error.code === '23505') {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Resource already exists', request_id: request.id } });
    }
    const clientError = normalizeHttpClientError(error);
    if (clientError) {
      return reply.code(clientError.statusCode).send({ error: {
        code: clientError.code, message: clientError.message, request_id: request.id,
      } });
    }
    request.log.error({ err: error, request_id: request.id }, 'Unhandled request error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error', request_id: request.id } });
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: {
    code: 'ROUTE_NOT_FOUND', message: 'Route not found', request_id: request.id,
  } }));

  await app.register(healthRoutes);
  await app.register(storefrontRoutes);
  await app.register(publicAssetRoutes);
  await app.register(storefrontCatalogRoutes);
  await app.register(customerAuthRoutes);
  await app.register(merchantAuthRoutes);
  await app.register(merchantTenantRoutes);
  await app.register(merchantCustomerExperienceRoutes);
  await app.register(merchantCustomerRoutes);
  await app.register(merchantAccessRoutes);
  await app.register(merchantCatalogRoutes);
  await app.register(merchantAssetRoutes);
  await app.register(merchantInventoryRoutes);
  await app.register(customerOrderRoutes);
  await app.register(merchantOrderRoutes);
  await app.register(merchantPaymentRoutes);
  await app.register(merchantDeliveryRoutes);
  await app.register(merchantPromotionRoutes);
  await app.register(customerCommerceRoutes);
  await app.register(customerSupportContextRoutes);
  await app.register(customerServiceMerchantRoutes);
  await app.register(customerServiceRoutes);
  await app.register(customerServiceToolRoutes);
  await app.register(platformAuthRoutes);
  await app.register(platformControlRoutes);

  app.addHook('onClose', async () => app.db.close());
  return app;
}
