-- Luke Shop Backend v0.15.0 — VIP & Loyalty RBAC compatibility backfill
-- Existing merchant roles predate loyalty.read / loyalty.manage. Preserve least privilege:
--   * roles that can already read customers inherit loyalty.read;
--   * roles that can both manage customer status and write tenant settings inherit loyalty.manage.
-- Explicit custom-role edits remain authoritative after this one-time additive backfill.

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT DISTINCT rp.role_id, 'loyalty.read'
  FROM merchant_role_permissions rp
 WHERE rp.permission_key = 'customers.read'
   AND EXISTS (SELECT 1 FROM merchant_permissions p WHERE p.key = 'loyalty.read')
ON CONFLICT DO NOTHING;

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT DISTINCT customer_admin.role_id, 'loyalty.manage'
  FROM merchant_role_permissions customer_admin
  JOIN merchant_role_permissions tenant_admin
    ON tenant_admin.role_id = customer_admin.role_id
   AND tenant_admin.permission_key = 'tenant.settings.write'
 WHERE customer_admin.permission_key = 'customers.status.manage'
   AND EXISTS (SELECT 1 FROM merchant_permissions p WHERE p.key = 'loyalty.manage')
ON CONFLICT DO NOTHING;

-- Any role trusted with loyalty.manage must also be able to enter/read the VIP workspace.
INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT DISTINCT rp.role_id, 'loyalty.read'
  FROM merchant_role_permissions rp
 WHERE rp.permission_key = 'loyalty.manage'
   AND EXISTS (SELECT 1 FROM merchant_permissions p WHERE p.key = 'loyalty.read')
ON CONFLICT DO NOTHING;
