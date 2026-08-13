import { publicId, uuid } from '../../../core/identifiers.js';
import { signSupportContext } from '../../../core/tokens.js';
import { errors } from '../../../core/errors.js';
import { resolveStore } from '../../catalog/service.js';
import { contextAllowedTools, getCustomerServicePolicy } from './policy.js';

export async function customerSupportContextRoutes(app) {
  app.post('/v1/customer/support/context', {
    preHandler: [app.requireCustomerAuth],
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      store_id: { type: 'string', minLength: 5, maxLength: 100 },
    } } },
  }, async (request, reply) => {
    const policy = await getCustomerServicePolicy(app.db, request.auth.tenantId);
    if (!policy?.enabled) throw errors.forbidden('SUPPORT_INTEGRATION_DISABLED', 'Customer support data integration is disabled');
    const allowedTools = contextAllowedTools(policy);
    if (!allowedTools.length) throw errors.forbidden('SUPPORT_TOOLS_DISABLED', 'No customer support data tools are enabled');
    const store = await resolveStore(app.db, request.auth.tenantId, request.body?.store_id || null);
    const signed = await signSupportContext(app.config, {
      tenantId: request.auth.tenantId,
      customerId: request.auth.actorId,
      customerPublicId: request.auth.profile.public_id,
      sessionId: request.auth.sessionId,
      storeId: store.id,
      storePublicId: store.public_id,
      allowedTools,
      ttlSeconds: policy.context_ttl_seconds,
    });
    const id = uuid();
    const contextPublicId = publicId('ctx');
    await app.db.query(
      `INSERT INTO customer_service_contexts(
         id,public_id,jti,tenant_id,customer_id,customer_session_id,store_id,allowed_tools,expires_at,request_id,request_ip
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, contextPublicId, signed.jti, request.auth.tenantId, request.auth.actorId, request.auth.sessionId,
        store.id, allowedTools, signed.expiresAt, request.id, request.ip || null],
    );
    return reply.code(201).send({ data: {
      context: signed.token,
      context_id: contextPublicId,
      expires_in: signed.expiresIn,
      store: { id: store.public_id, name: store.name },
      allowed_tools: allowedTools,
    } });
  });

  app.post('/v1/customer/support/context/revoke', {
    preHandler: [app.requireCustomerAuth],
  }, async (request) => {
    const result = await app.db.query(
      `UPDATE customer_service_contexts SET revoked_at=now()
        WHERE tenant_id=$1 AND customer_id=$2 AND customer_session_id=$3 AND revoked_at IS NULL AND expires_at>now()`,
      [request.auth.tenantId, request.auth.actorId, request.auth.sessionId],
    );
    return { data: { revoked: result.rowCount } };
  });
}
