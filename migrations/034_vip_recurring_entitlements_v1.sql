-- Luke Shop Backend v0.15.0 — VIP recurring voucher/gift issuance v1
-- Additive only. Existing VIP entitlements and order-driven issuance remain authoritative.
-- Recurring issuance is explicitly disabled by default and does not backfill old tier-entry events.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS birth_date date;

DO $$ BEGIN
  ALTER TABLE customers
    ADD CONSTRAINT customers_birth_date_min_check
    CHECK (birth_date IS NULL OR birth_date >= DATE '1900-01-01');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE vip_programs
  ADD COLUMN IF NOT EXISTS recurring_entitlement_issuance_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurring_entitlement_issuance_enabled_at timestamptz;

UPDATE vip_programs
SET recurring_entitlement_issuance_enabled_at = NULL
WHERE recurring_entitlement_issuance_enabled = false
  AND recurring_entitlement_issuance_enabled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS customers_birth_date_idx
  ON customers(tenant_id,birth_date)
  WHERE birth_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS vip_tier_history_entry_issuance_idx
  ON vip_tier_history(tenant_id,store_id,customer_id,to_level_id,id DESC)
  WHERE to_level_id IS NOT NULL;
