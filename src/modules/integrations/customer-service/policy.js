const TOOL_POLICY = Object.freeze({
  'customer.get': { scope: 'customer.read', general: 'customer_read', ai: 'ai_customer_read' },
  'product.search': { scope: 'product.read', general: 'product_read', ai: 'ai_product_read' },
  'product.get': { scope: 'product.read', general: 'product_read', ai: 'ai_product_read' },
  'orders.list': { scope: 'orders.read', general: 'orders_read', ai: 'ai_orders_read' },
  'order.get': { scope: 'orders.read', general: 'orders_read', ai: 'ai_orders_read' },
  'order.status': { scope: 'order_status.read', general: 'orders_read', ai: 'ai_orders_read' },
  'payment.status': { scope: 'payments.read', general: 'payments_read', ai: 'ai_payments_read' },
  'delivery.status': { scope: 'delivery.read', general: 'delivery_read', ai: 'ai_delivery_read' },
});

export const CS_TOOL_NAMES = Object.freeze(Object.keys(TOOL_POLICY));


export async function ensureCustomerServicePolicy(client, tenantId, { enabled = false } = {}) {
  await client.query(
    `INSERT INTO customer_service_policies(tenant_id,enabled)
     VALUES($1,$2) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, enabled],
  );
  if (enabled) await client.query('UPDATE customer_service_policies SET enabled=true,updated_at=now() WHERE tenant_id=$1', [tenantId]);
}

export async function getCustomerServicePolicy(db, tenantId) {
  const result = await db.query(
    `SELECT tenant_id,enabled,customer_read,product_read,orders_read,payments_read,delivery_read,
            ai_customer_read,ai_product_read,ai_orders_read,ai_payments_read,ai_delivery_read,
            context_ttl_seconds,tool_rate_limit_per_minute,created_at,updated_at
       FROM customer_service_policies WHERE tenant_id=$1`,
    [tenantId],
  );
  return result.rows[0] || null;
}

export function toolPolicy(toolName) {
  return TOOL_POLICY[toolName] || null;
}

export function isToolAllowed(policy, usageMode, toolName) {
  const rule = toolPolicy(toolName);
  if (!policy?.enabled || !rule || !policy[rule.general]) return false;
  if (usageMode === 'AI' && !policy[rule.ai]) return false;
  return true;
}

export function toolsAllowedByPolicy(policy, usageMode = 'STAFF') {
  return CS_TOOL_NAMES.filter((tool) => isToolAllowed(policy, usageMode, tool));
}

export function contextAllowedTools(policy) {
  if (!policy?.enabled) return [];
  return CS_TOOL_NAMES.filter((tool) => {
    const rule = TOOL_POLICY[tool];
    return Boolean(policy[rule.general]);
  });
}
