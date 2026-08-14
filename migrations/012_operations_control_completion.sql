-- Luke Shop Backend v0.11.0 — Operations & Control Completion
-- Additive migration. Migrations 001-011 remain immutable.

INSERT INTO merchant_permissions(key, description) VALUES
('stores.read','Read tenant stores and storefront context'),
('stores.manage','Create and manage tenant stores'),
('audit.read','Read tenant audit log')
ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT r.id, p.key
  FROM merchant_roles r
  JOIN merchant_permissions p ON p.key IN ('stores.read','stores.manage','audit.read')
 WHERE r.key='OWNER'
ON CONFLICT DO NOTHING;

ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS public_id text;
UPDATE customer_sessions
   SET public_id = 'cses_' || replace(gen_random_uuid()::text,'-','')
 WHERE public_id IS NULL;
ALTER TABLE customer_sessions ALTER COLUMN public_id SET DEFAULT ('cses_' || replace(gen_random_uuid()::text,'-',''));
ALTER TABLE customer_sessions ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_sessions_public_id_idx ON customer_sessions(public_id);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

ALTER TABLE promotion_targets ADD COLUMN IF NOT EXISTS public_id text;
UPDATE promotion_targets
   SET public_id = 'ptgt_' || replace(gen_random_uuid()::text,'-','')
 WHERE public_id IS NULL;
ALTER TABLE promotion_targets ALTER COLUMN public_id SET DEFAULT ('ptgt_' || replace(gen_random_uuid()::text,'-',''));
ALTER TABLE promotion_targets ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS promotion_targets_public_id_idx ON promotion_targets(public_id);


-- A customer can have only one default saved address per tenant account.
CREATE UNIQUE INDEX IF NOT EXISTS customer_addresses_one_default_idx
  ON customer_addresses(tenant_id,customer_id) WHERE is_default=true;

CREATE TABLE IF NOT EXISTS payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('REQUESTED','PROCESSING','SUCCEEDED','FAILED','CANCELLED')),
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  reason text,
  provider_reference text,
  failure_code text,
  failure_message text,
  previous_order_status text NOT NULL,
  previous_payment_status text NOT NULL,
  requested_by uuid REFERENCES merchant_users(id) ON DELETE SET NULL,
  completed_by uuid REFERENCES merchant_users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,payment_id) REFERENCES order_payments(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payment_refunds_store_status_idx
  ON payment_refunds(tenant_id,store_id,status,requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payment_refunds_one_open_per_payment_idx
  ON payment_refunds(tenant_id,store_id,payment_id)
  WHERE status IN ('REQUESTED','PROCESSING');

-- Platform owner/admin self-service security uses opaque session identifiers as well.
ALTER TABLE platform_sessions ADD COLUMN IF NOT EXISTS public_id text;
UPDATE platform_sessions
   SET public_id = 'pses_' || replace(gen_random_uuid()::text,'-','')
 WHERE public_id IS NULL;
ALTER TABLE platform_sessions ALTER COLUMN public_id SET DEFAULT ('pses_' || replace(gen_random_uuid()::text,'-',''));
ALTER TABLE platform_sessions ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_sessions_public_id_idx ON platform_sessions(public_id);

ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
