-- Luke Shop Backend v0.6.0 — Merchant Staff & RBAC Management
-- Additive migration. Migrations 001-005 remain immutable.

INSERT INTO merchant_permissions(key, description) VALUES
('merchant.staff.read','Read merchant staff accounts and sessions'),
('merchant.staff.manage','Create and manage merchant staff accounts'),
('merchant.roles.read','Read merchant roles and permissions'),
('merchant.roles.manage','Create and manage non-system merchant roles'),
('merchant.sessions.manage','Revoke merchant staff sessions')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT r.id, p.key
FROM merchant_roles r
JOIN merchant_permissions p ON p.key IN (
  'merchant.staff.read',
  'merchant.staff.manage',
  'merchant.roles.read',
  'merchant.roles.manage',
  'merchant.sessions.manage'
)
WHERE r.key = 'OWNER'
ON CONFLICT DO NOTHING;

-- Preserve legacy BLOCKED while adding the explicit DISABLED state used by the
-- merchant staff management API.
ALTER TABLE merchant_users DROP CONSTRAINT IF EXISTS merchant_users_status_check;
ALTER TABLE merchant_users ADD CONSTRAINT merchant_users_status_check
  CHECK (status IN ('ACTIVE','SUSPENDED','BLOCKED','DISABLED'));

ALTER TABLE merchant_users
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

ALTER TABLE merchant_roles
  ADD COLUMN IF NOT EXISTS public_id text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE merchant_roles
SET public_id = 'mrol_' || encode(gen_random_bytes(12), 'hex')
WHERE public_id IS NULL;
ALTER TABLE merchant_roles ALTER COLUMN public_id SET DEFAULT ('mrol_' || encode(gen_random_bytes(12), 'hex'));
ALTER TABLE merchant_roles ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS merchant_roles_public_id_uidx ON merchant_roles(public_id);
CREATE INDEX IF NOT EXISTS merchant_roles_tenant_system_idx ON merchant_roles(tenant_id, is_system, key);

ALTER TABLE merchant_sessions
  ADD COLUMN IF NOT EXISTS public_id text;
UPDATE merchant_sessions
SET public_id = 'mses_' || encode(gen_random_bytes(12), 'hex')
WHERE public_id IS NULL;
ALTER TABLE merchant_sessions ALTER COLUMN public_id SET DEFAULT ('mses_' || encode(gen_random_bytes(12), 'hex'));
ALTER TABLE merchant_sessions ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS merchant_sessions_public_id_uidx ON merchant_sessions(public_id);
CREATE INDEX IF NOT EXISTS merchant_sessions_tenant_user_active_idx
  ON merchant_sessions(tenant_id, merchant_user_id, revoked_at, expires_at DESC);
