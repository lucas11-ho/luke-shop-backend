import { createHash } from 'node:crypto';
import { errors } from '../../../core/errors.js';
import { verifySupportContext } from '../../../core/tokens.js';

export function hashRequestNonce(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export async function consumeFreshServiceNonce(app, request) {
  const rawTimestamp = String(request.headers['x-luke-request-timestamp'] || '').trim();
  const nonce = String(request.headers['x-luke-request-nonce'] || '').trim();
  if (!/^\d{10,13}$/.test(rawTimestamp)) {
    throw errors.unauthorized('SERVICE_REQUEST_TIMESTAMP_REQUIRED', 'Fresh service request timestamp required');
  }
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(nonce)) {
    throw errors.unauthorized('SERVICE_REQUEST_NONCE_REQUIRED', 'Fresh service request nonce required');
  }
  let timestampMs = Number(rawTimestamp);
  if (rawTimestamp.length === 10) timestampMs *= 1000;
  const skewMs = Math.abs(Date.now() - timestampMs);
  if (!Number.isFinite(timestampMs) || skewMs > app.config.csRequestMaxSkewSeconds * 1000) {
    throw errors.unauthorized('SERVICE_REQUEST_STALE', 'Service request timestamp is outside the allowed window');
  }
  const nonceHash = hashRequestNonce(nonce);
  const inserted = await app.db.query(
    `INSERT INTO customer_service_request_nonces(
       tenant_id,integration_client_id,nonce_hash,request_timestamp,expires_at
     ) VALUES($1,$2,$3,to_timestamp($4 / 1000.0),now()+($5::text || ' seconds')::interval)
     ON CONFLICT (tenant_id,integration_client_id,nonce_hash) DO NOTHING RETURNING id`,
    [request.serviceAuth.tenantId, request.serviceAuth.clientId, nonceHash, timestampMs, app.config.csRequestNonceTtlSeconds],
  );
  if (!inserted.rowCount) throw errors.unauthorized('SERVICE_REQUEST_REPLAYED', 'Service request nonce has already been used');
  request.serviceRequest = { nonceHash, timestampMs };
}

export async function resolveSupportContext(app, request) {
  const token = String(request.headers['x-luke-shop-context'] || '').trim();
  if (!token) throw errors.unauthorized('SUPPORT_CONTEXT_REQUIRED', 'Signed customer support context required');
  let payload;
  try { payload = await verifySupportContext(app.config, token); }
  catch { throw errors.unauthorized('SUPPORT_CONTEXT_INVALID', 'Signed customer support context is invalid or expired'); }
  if (payload.tenant_id !== request.serviceAuth.tenantId) {
    throw errors.forbidden('SUPPORT_CONTEXT_TENANT_MISMATCH', 'Support context does not belong to this tenant');
  }
  const found = await app.db.query(
    `SELECT ctx.id,ctx.public_id,ctx.jti,ctx.tenant_id,ctx.customer_id,ctx.customer_session_id,ctx.store_id,ctx.allowed_tools,
            c.public_id AS customer_public_id,c.display_name,c.status AS customer_status,
            s.public_id AS store_public_id,s.name AS store_name
       FROM customer_service_contexts ctx
       JOIN customers c ON c.id=ctx.customer_id AND c.tenant_id=ctx.tenant_id
       JOIN customer_sessions cs ON cs.id=ctx.customer_session_id AND cs.tenant_id=ctx.tenant_id AND cs.customer_id=ctx.customer_id
       JOIN stores s ON s.id=ctx.store_id AND s.tenant_id=ctx.tenant_id
      WHERE ctx.tenant_id=$1 AND ctx.jti=$2 AND ctx.revoked_at IS NULL AND ctx.expires_at>now()
        AND cs.revoked_at IS NULL AND cs.expires_at>now() AND c.status='ACTIVE' AND s.status='ACTIVE'`,
    [request.serviceAuth.tenantId, payload.jti],
  );
  if (!found.rowCount) throw errors.unauthorized('SUPPORT_CONTEXT_INVALID', 'Support context is no longer active');
  const row = found.rows[0];
  if (String(payload.sub) !== String(row.customer_id) || String(payload.session_id) !== String(row.customer_session_id)
      || String(payload.store_id) !== String(row.store_id)) {
    throw errors.unauthorized('SUPPORT_CONTEXT_INVALID', 'Support context binding is invalid');
  }
  request.supportContext = row;
}
