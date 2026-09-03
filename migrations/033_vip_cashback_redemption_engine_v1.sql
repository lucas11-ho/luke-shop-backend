-- Shope / Luke Shop Backend — VIP Cashback Redemption Engine v1
-- Additive migration. Migrations 001-032 remain immutable.
-- Redemption is server-authoritative and allocated to immutable positive reward-ledger sources.

ALTER TABLE vip_programs
  ADD COLUMN IF NOT EXISTS cashback_redemption_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cashback_redemption_max_percent numeric(5,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS cashback_redemption_min_amount numeric(18,4) NOT NULL DEFAULT 0;
ALTER TABLE vip_programs DROP CONSTRAINT IF EXISTS vip_programs_cashback_redemption_max_percent_check;
ALTER TABLE vip_programs ADD CONSTRAINT vip_programs_cashback_redemption_max_percent_check
  CHECK (cashback_redemption_max_percent >= 0 AND cashback_redemption_max_percent <= 100);
ALTER TABLE vip_programs DROP CONSTRAINT IF EXISTS vip_programs_cashback_redemption_min_amount_check;
ALTER TABLE vip_programs ADD CONSTRAINT vip_programs_cashback_redemption_min_amount_check
  CHECK (cashback_redemption_min_amount >= 0);

ALTER TABLE order_adjustments DROP CONSTRAINT IF EXISTS order_adjustments_adjustment_type_check;
ALTER TABLE order_adjustments
  ADD CONSTRAINT order_adjustments_adjustment_type_check
  CHECK (adjustment_type IN ('PROMOTION','DELIVERY','TAX','MANUAL','VIP_BENEFIT','VIP_REDEMPTION'));

ALTER TABLE vip_reward_ledger DROP CONSTRAINT IF EXISTS vip_reward_ledger_entry_type_check;
ALTER TABLE vip_reward_ledger
  ADD CONSTRAINT vip_reward_ledger_entry_type_check
  CHECK (entry_type IN ('EARN','REDEEM','REDEMPTION_RESTORE','EXPIRE','REVERSAL','ADMIN_ADJUSTMENT','REFUND_CLAWBACK'));

ALTER TABLE vip_reward_ledger DROP CONSTRAINT IF EXISTS vip_reward_ledger_check;
ALTER TABLE vip_reward_ledger
  ADD CONSTRAINT vip_reward_ledger_amount_by_type_check
  CHECK (
    (entry_type IN ('EARN','REDEMPTION_RESTORE') AND amount > 0)
    OR entry_type = 'ADMIN_ADJUSTMENT'
    OR (entry_type IN ('REDEEM','EXPIRE','REVERSAL','REFUND_CLAWBACK') AND amount < 0)
  );

ALTER TABLE payment_refunds DROP CONSTRAINT IF EXISTS payment_refunds_amount_check;
ALTER TABLE payment_refunds
  ADD CONSTRAINT payment_refunds_amount_check CHECK (amount >= 0);

CREATE TABLE vip_reward_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  ledger_entry_id uuid NOT NULL,
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  currency varchar(12) NOT NULL,
  status text NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','RESTORED')),
  restoration_reason text,
  restored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,order_id),
  UNIQUE (tenant_id,store_id,ledger_entry_id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,ledger_entry_id) REFERENCES vip_reward_ledger(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX vip_reward_redemptions_customer_idx ON vip_reward_redemptions(tenant_id,store_id,customer_id,status,created_at DESC);

CREATE TABLE vip_reward_redemption_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  redemption_id uuid NOT NULL,
  source_ledger_entry_id uuid NOT NULL,
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,redemption_id,source_ledger_entry_id),
  FOREIGN KEY (tenant_id,store_id,redemption_id) REFERENCES vip_reward_redemptions(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,source_ledger_entry_id) REFERENCES vip_reward_ledger(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX vip_reward_redemption_alloc_source_idx ON vip_reward_redemption_allocations(tenant_id,store_id,source_ledger_entry_id);
