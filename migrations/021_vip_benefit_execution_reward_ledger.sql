-- Luke Shop Backend v0.15.0 — VIP & Loyalty v1.1 benefit execution + reward accounting
-- Additive only. Historical orders are intentionally NOT backfilled with rewards.

ALTER TABLE vip_programs
  ADD COLUMN IF NOT EXISTS upgrade_policy text NOT NULL DEFAULT 'IMMEDIATE'
    CHECK (upgrade_policy IN ('IMMEDIATE','SCHEDULED','MANUAL'));

ALTER TABLE order_adjustments DROP CONSTRAINT IF EXISTS order_adjustments_adjustment_type_check;
ALTER TABLE order_adjustments
  ADD CONSTRAINT order_adjustments_adjustment_type_check
  CHECK (adjustment_type IN ('PROMOTION','DELIVERY','TAX','MANUAL','VIP_BENEFIT'));

CREATE TABLE order_vip_benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  level_id uuid,
  benefit_id uuid NOT NULL,
  benefit_type text NOT NULL CHECK (benefit_type IN ('FREE_DELIVERY','CASHBACK','VOUCHER','GIFT')),
  frequency text NOT NULL CHECK (frequency IN ('TIER_ENTRY','EVERY_ORDER','MONTHLY','ANNUAL','BIRTHDAY','MANUAL')),
  status text NOT NULL DEFAULT 'SNAPSHOT' CHECK (status IN ('SNAPSHOT','APPLIED','EARNED','ISSUED','REVERSED','SKIPPED')),
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount numeric(18,4) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency varchar(12) NOT NULL,
  reason text,
  executed_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, order_id, benefit_id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES orders(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, level_id) REFERENCES vip_levels(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, benefit_id) REFERENCES vip_benefits(tenant_id, store_id, id) ON DELETE RESTRICT
);
CREATE INDEX order_vip_benefits_customer_idx ON order_vip_benefits(tenant_id, store_id, customer_id, created_at DESC);
CREATE INDEX order_vip_benefits_order_idx ON order_vip_benefits(tenant_id, store_id, order_id, status);

CREATE TABLE vip_reward_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid,
  benefit_id uuid,
  order_vip_benefit_id uuid,
  related_entry_id uuid,
  entry_type text NOT NULL CHECK (entry_type IN ('EARN','REDEEM','EXPIRE','REVERSAL','ADMIN_ADJUSTMENT','REFUND_CLAWBACK')),
  amount numeric(18,4) NOT NULL CHECK (amount <> 0),
  currency varchar(12) NOT NULL,
  source_key text NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, source_key),
  CHECK (
    (entry_type = 'EARN' AND amount > 0)
    OR entry_type = 'ADMIN_ADJUSTMENT'
    OR (entry_type IN ('REDEEM','EXPIRE','REVERSAL','REFUND_CLAWBACK') AND amount < 0)
  ),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES orders(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, benefit_id) REFERENCES vip_benefits(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, order_vip_benefit_id) REFERENCES order_vip_benefits(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, related_entry_id) REFERENCES vip_reward_ledger(tenant_id, store_id, id) ON DELETE RESTRICT
);
CREATE INDEX vip_reward_ledger_customer_idx ON vip_reward_ledger(tenant_id, store_id, customer_id, created_at DESC, id);
CREATE INDEX vip_reward_ledger_expiry_idx ON vip_reward_ledger(tenant_id, store_id, expires_at)
  WHERE (entry_type='EARN' OR (entry_type='ADMIN_ADJUSTMENT' AND amount>0)) AND expires_at IS NOT NULL;
CREATE INDEX vip_reward_ledger_order_idx ON vip_reward_ledger(tenant_id, store_id, order_id, created_at DESC) WHERE order_id IS NOT NULL;

CREATE TABLE vip_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  level_id uuid,
  benefit_id uuid NOT NULL,
  source_order_id uuid,
  redeemed_order_id uuid,
  entitlement_type text NOT NULL CHECK (entitlement_type IN ('VOUCHER','GIFT')),
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','REDEEMED','EXPIRED','CANCELLED')),
  redeem_code text,
  issuance_key text NOT NULL,
  payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  issued_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, issuance_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, level_id) REFERENCES vip_levels(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, benefit_id) REFERENCES vip_benefits(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, source_order_id) REFERENCES orders(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, redeemed_order_id) REFERENCES orders(tenant_id, store_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX vip_entitlements_redeem_code_uq ON vip_entitlements(tenant_id, store_id, redeem_code) WHERE redeem_code IS NOT NULL;
CREATE INDEX vip_entitlements_customer_idx ON vip_entitlements(tenant_id, store_id, customer_id, status, created_at DESC);
CREATE INDEX vip_entitlements_expiry_idx ON vip_entitlements(tenant_id, store_id, expires_at) WHERE status='AVAILABLE' AND expires_at IS NOT NULL;
