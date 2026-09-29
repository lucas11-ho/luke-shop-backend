-- Luke Shop Backend — Bot Pilot Shop integration v1
-- Additive, idempotent foundation for Bot Pilot-provisioned tenants.

CREATE TABLE IF NOT EXISTS bot_pilot_shop_links (
  child_bot_id bigint PRIMARY KEY,
  shop_public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  merchant_user_id uuid NOT NULL REFERENCES merchant_users(id) ON DELETE CASCADE,
  owner_telegram_user_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id)
);

CREATE INDEX IF NOT EXISTS bot_pilot_shop_links_tenant_idx
  ON bot_pilot_shop_links(tenant_id);
CREATE INDEX IF NOT EXISTS bot_pilot_shop_links_owner_tg_idx
  ON bot_pilot_shop_links(owner_telegram_user_id);

CREATE TABLE IF NOT EXISTS bot_pilot_request_nonces (
  nonce text PRIMARY KEY,
  used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS bot_pilot_request_nonces_expires_idx
  ON bot_pilot_request_nonces(expires_at);

CREATE TABLE IF NOT EXISTS bot_pilot_integration_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  child_bot_id bigint,
  shop_public_id text,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bot_pilot_integration_audit_created_idx
  ON bot_pilot_integration_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS bot_pilot_integration_audit_child_idx
  ON bot_pilot_integration_audit(child_bot_id, created_at DESC);
