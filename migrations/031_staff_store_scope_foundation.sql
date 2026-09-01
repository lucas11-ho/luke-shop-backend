-- Shope / Luke Shop Backend — Staff Store Scope Foundation v1
-- Additive migration. Migrations 001-030 remain immutable.
-- Existing merchant users keep ALL_STORES access unless explicitly narrowed.

ALTER TABLE merchant_users
  ADD COLUMN IF NOT EXISTS store_access_mode text NOT NULL DEFAULT 'ALL_STORES';

ALTER TABLE merchant_users DROP CONSTRAINT IF EXISTS merchant_users_store_access_mode_check;
ALTER TABLE merchant_users ADD CONSTRAINT merchant_users_store_access_mode_check
  CHECK (store_access_mode IN ('ALL_STORES','ASSIGNED_STORES'));

CREATE TABLE IF NOT EXISTS merchant_user_store_access (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_user_id uuid NOT NULL,
  store_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,merchant_user_id,store_id),
  FOREIGN KEY (tenant_id,merchant_user_id)
    REFERENCES merchant_users(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id)
    REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,created_by)
    REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS merchant_user_store_access_user_idx
  ON merchant_user_store_access(tenant_id,merchant_user_id,created_at);
CREATE INDEX IF NOT EXISTS merchant_user_store_access_store_idx
  ON merchant_user_store_access(tenant_id,store_id,merchant_user_id);
