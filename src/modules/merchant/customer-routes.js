import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';

const ALLOWED_STATUS = new Set(['ACTIVE', 'SUSPENDED', 'BLOCKED']);

export async function merchantCustomerRoutes(app) {
  app.get('/v1/merchant/customers', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMERS_READ)],
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'BLOCKED', 'DELETION_PENDING'] },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
    } } },
  }, async (request) => {
    const { status, limit = 50, offset = 0 } = request.query;
    const values = [request.auth.tenantId];
    let where = 'WHERE tenant_id = $1';
    if (status) { values.push(status); where += ` AND status = $${values.length}`; }
    values.push(limit, offset);
    const result = await app.db.query(
      `SELECT public_id, email, display_name, status, created_at, last_login_at
         FROM customers ${where}
        ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { data: { customers: result.rows, limit, offset } };
  });

  app.get('/v1/merchant/customers/:customerId', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMERS_READ)],
  }, async (request) => {
    const result = await app.db.query(
      `SELECT public_id, email, display_name, status, created_at, updated_at, last_login_at
         FROM customers WHERE tenant_id = $1 AND public_id = $2`,
      [request.auth.tenantId, request.params.customerId],
    );
    if (!result.rowCount) throw errors.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
    return { data: { customer: result.rows[0] } };
  });

  app.patch('/v1/merchant/customers/:customerId/status', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMERS_STATUS_MANAGE)],
    schema: { body: { type: 'object', additionalProperties: false, required: ['status'], properties: {
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'BLOCKED'] },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
    } } },
  }, async (request) => {
    if (!ALLOWED_STATUS.has(request.body.status)) throw errors.badRequest('CUSTOMER_STATUS_INVALID', 'Invalid customer status');
    const result = await app.db.transaction(async (client) => {
      const found = await client.query(
        'SELECT id, public_id, status FROM customers WHERE tenant_id = $1 AND public_id = $2 FOR UPDATE',
        [request.auth.tenantId, request.params.customerId],
      );
      if (!found.rowCount) throw errors.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
      const customer = found.rows[0];
      if (customer.status === request.body.status) return customer;
      await client.query(
        'UPDATE customers SET status = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3',
        [request.body.status, request.auth.tenantId, customer.id],
      );
      if (request.body.status !== 'ACTIVE') {
        await client.query(
          'UPDATE customer_sessions SET revoked_at = now() WHERE tenant_id = $1 AND customer_id = $2 AND revoked_at IS NULL',
          [request.auth.tenantId, customer.id],
        );
      }
      await client.query(
        `INSERT INTO customer_status_history(tenant_id, customer_id, from_status, to_status, reason, changed_by_type, changed_by_id)
         VALUES($1,$2,$3,$4,$5,'MERCHANT',$6)`,
        [request.auth.tenantId, customer.id, customer.status, request.body.status, request.body.reason || null, request.auth.actorId],
      );
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'customer.status.update', targetType: 'customer', targetId: customer.id,
        metadata: { from: customer.status, to: request.body.status, reason: request.body.reason || null },
        requestIp: request.ip, requestId: request.id });
      return { ...customer, status: request.body.status };
    });
    return { data: { customer: { id: result.public_id, status: result.status } } };
  });
}
