import { publicId, uuid } from '../../../core/identifiers.js';
import { signSupportContext } from '../../../core/tokens.js';
import { errors } from '../../../core/errors.js';
import { resolveStore } from '../../catalog/service.js';
import { contextAllowedTools, getCustomerServicePolicy } from './policy.js';

function cleanPagePath(value) {
  const text=String(value||'').trim();
  if(!text)return null;
  if(text.length>500||!text.startsWith('/')||text.startsWith('//'))throw errors.badRequest('SUPPORT_PAGE_PATH_INVALID','Current page path is invalid');
  return text;
}
function cleanLocale(value){const text=String(value||'').trim();return text&&/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(text)?text.slice(0,35):null;}
function cleanOrderRef(value){const text=String(value||'').trim();if(!text)return null;if(text.length>160||!/^[A-Za-z0-9_-]+$/.test(text))throw errors.badRequest('SUPPORT_ORDER_REF_INVALID','Current order reference is invalid');return text;}

export async function customerSupportContextRoutes(app) {
  app.post('/v1/customer/support/context', {
    preHandler: [app.requireCustomerAuth],
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      store_id: { type: 'string', minLength: 5, maxLength: 100 },
      current_path: { type:'string', maxLength:500 },
      order_ref: { type:'string', maxLength:160 },
      locale: { type:'string', maxLength:35 },
    } } },
  }, async (request, reply) => {
    const policy = await getCustomerServicePolicy(app.db, request.auth.tenantId);
    if (!policy?.enabled) throw errors.forbidden('SUPPORT_INTEGRATION_DISABLED', 'Customer support data integration is disabled');
    const allowedTools = contextAllowedTools(policy);
    if (!allowedTools.length) throw errors.forbidden('SUPPORT_TOOLS_DISABLED', 'No customer support data tools are enabled');
    const store = await resolveStore(app.db, request.auth.tenantId, request.body?.store_id || null);
    const pagePath=cleanPagePath(request.body?.current_path);
    const locale=cleanLocale(request.body?.locale);
    const orderRef=cleanOrderRef(request.body?.order_ref);
    const customer=(await app.db.query('SELECT customer_code FROM customers WHERE tenant_id=$1 AND id=$2 LIMIT 1',[request.auth.tenantId,request.auth.actorId])).rows[0];
    let currentOrder=null;
    if(orderRef){
      currentOrder=(await app.db.query(`SELECT id,public_id,order_number FROM orders WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND (public_id=$4 OR order_number=$4) LIMIT 1`,[request.auth.tenantId,store.id,request.auth.actorId,orderRef])).rows[0]||null;
      if(!currentOrder)throw errors.notFound('ORDER_NOT_FOUND','Order not found');
    }
    const currentOrderRef=currentOrder?.order_number||currentOrder?.public_id||null;
    const signed = await signSupportContext(app.config, {
      tenantId: request.auth.tenantId,
      customerId: request.auth.actorId,
      customerPublicId: request.auth.profile.public_id,
      customerCode: customer?.customer_code || null,
      sessionId: request.auth.sessionId,
      storeId: store.id,
      storePublicId: store.public_id,
      pagePath, currentOrderRef, locale, allowedTools,
      ttlSeconds: policy.context_ttl_seconds,
    });
    const id = uuid();
    const contextPublicId = publicId('ctx');
    await app.db.query(
      `INSERT INTO customer_service_contexts(
         id,public_id,jti,tenant_id,customer_id,customer_session_id,store_id,allowed_tools,expires_at,request_id,request_ip,page_path,current_order_id,locale,customer_code_snapshot
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, contextPublicId, signed.jti, request.auth.tenantId, request.auth.actorId, request.auth.sessionId,
        store.id, allowedTools, signed.expiresAt, request.id, request.ip || null,pagePath,currentOrder?.id||null,locale,customer?.customer_code||null],
    );
    return reply.code(201).send({ data: {
      context: signed.token, context_id: contextPublicId, expires_in: signed.expiresIn,
      customer: { id: request.auth.profile.public_id, customer_code: customer?.customer_code || null },
      store: { id: store.public_id, name: store.name },
      page_path: pagePath, current_order_ref: currentOrderRef, locale, allowed_tools: allowedTools,
    } });
  });

  app.post('/v1/customer/support/context/revoke', { preHandler: [app.requireCustomerAuth] }, async (request) => {
    const result = await app.db.query(
      `UPDATE customer_service_contexts SET revoked_at=now()
        WHERE tenant_id=$1 AND customer_id=$2 AND customer_session_id=$3 AND revoked_at IS NULL AND expires_at>now()`,
      [request.auth.tenantId, request.auth.actorId, request.auth.sessionId],
    );
    return { data: { revoked: result.rowCount } };
  });
}
