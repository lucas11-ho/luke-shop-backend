-- Shope / Luke Shop Backend — Zone-Aware Delivery Pricing v1
-- Additive migration. Migrations 001-025 remain immutable.
--
-- Existing delivery methods stay on BASELINE pricing. Zone rates affect checkout
-- only after a merchant explicitly opts a SHIPPING or LOCAL_DELIVERY method into
-- ZONE_AWARE pricing through the guarded pricing-policy API.

ALTER TABLE delivery_methods
  ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'BASELINE',
  ADD COLUMN IF NOT EXISTS zone_no_match_policy text NOT NULL DEFAULT 'UNAVAILABLE';

ALTER TABLE delivery_methods DROP CONSTRAINT IF EXISTS delivery_methods_pricing_mode_check;
ALTER TABLE delivery_methods ADD CONSTRAINT delivery_methods_pricing_mode_check
  CHECK (pricing_mode IN ('BASELINE','ZONE_AWARE'));

ALTER TABLE delivery_methods DROP CONSTRAINT IF EXISTS delivery_methods_zone_no_match_policy_check;
ALTER TABLE delivery_methods ADD CONSTRAINT delivery_methods_zone_no_match_policy_check
  CHECK (zone_no_match_policy IN ('UNAVAILABLE','BASELINE_FALLBACK'));

ALTER TABLE delivery_methods DROP CONSTRAINT IF EXISTS delivery_methods_zone_pricing_mode_check;
ALTER TABLE delivery_methods ADD CONSTRAINT delivery_methods_zone_pricing_mode_check
  CHECK (pricing_mode='BASELINE' OR fulfillment_mode IN ('SHIPPING','LOCAL_DELIVERY'));

ALTER TABLE order_fulfillments
  ADD COLUMN IF NOT EXISTS delivery_zone_id uuid,
  ADD COLUMN IF NOT EXISTS delivery_zone_rate_id uuid,
  ADD COLUMN IF NOT EXISTS delivery_pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE order_fulfillments ADD CONSTRAINT order_fulfillments_delivery_zone_fk
    FOREIGN KEY (tenant_id,store_id,delivery_zone_id)
    REFERENCES delivery_zones(tenant_id,store_id,id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE order_fulfillments ADD CONSTRAINT order_fulfillments_delivery_zone_rate_fk
    FOREIGN KEY (tenant_id,store_id,delivery_zone_rate_id)
    REFERENCES delivery_zone_rates(tenant_id,store_id,id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS order_fulfillments_delivery_zone_idx
  ON order_fulfillments(tenant_id,store_id,delivery_zone_id,created_at DESC)
  WHERE delivery_zone_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS order_fulfillments_delivery_zone_rate_idx
  ON order_fulfillments(tenant_id,store_id,delivery_zone_rate_id,created_at DESC)
  WHERE delivery_zone_rate_id IS NOT NULL;
