-- Shope / Luke Shop Backend — Finance & Reconciliation Center v1 A10.2
-- Additive migration. Migrations 001-041 remain immutable.
--
-- Finance Center is an owner/management read-model over existing authoritative
-- order payment, refund and COD custody/reconciliation state. It does not create
-- a second settlement ledger or weaken the existing COD reconciliation guards.

INSERT INTO merchant_permissions(key,description) VALUES
('finance.read','Read store finance overview, refund attention and COD reconciliation queues')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO merchant_role_permissions(role_id,permission_key)
SELECT r.id,'finance.read'
FROM merchant_roles r
WHERE r.key='OWNER'
ON CONFLICT DO NOTHING;
