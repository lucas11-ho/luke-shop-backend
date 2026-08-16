-- Luke Shop Backend v0.12.0 — Customer Delivery Location + Status Visual System
-- Additive migration. Migrations 001-012 remain immutable.

ALTER TABLE customer_addresses
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS accuracy_meters double precision,
  ADD COLUMN IF NOT EXISTS location_source text,
  ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;

ALTER TABLE order_addresses
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS accuracy_meters double precision,
  ADD COLUMN IF NOT EXISTS location_source text,
  ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;

ALTER TABLE order_fulfillments
  ADD COLUMN IF NOT EXISTS estimated_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS estimated_delivery_at timestamptz;

CREATE TABLE IF NOT EXISTS order_delivery_location_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters double precision CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
  location_source text NOT NULL CHECK (location_source IN ('GPS','MAP_PIN','ADDRESS')),
  event_type text NOT NULL CHECK (event_type IN ('CHECKOUT_SNAPSHOT','CUSTOMER_UPDATE','LIVE_PING')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS order_delivery_location_events_order_idx
  ON order_delivery_location_events(tenant_id,store_id,order_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS customer_live_location_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','STOPPED','EXPIRED')),
  last_latitude double precision CHECK (last_latitude IS NULL OR last_latitude BETWEEN -90 AND 90),
  last_longitude double precision CHECK (last_longitude IS NULL OR last_longitude BETWEEN -180 AND 180),
  last_accuracy_meters double precision CHECK (last_accuracy_meters IS NULL OR last_accuracy_meters >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_ping_at timestamptz,
  expires_at timestamptz NOT NULL,
  stopped_at timestamptz,
  stop_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_live_location_one_active_idx
  ON customer_live_location_sessions(tenant_id,store_id,order_id,customer_id)
  WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS customer_live_location_active_idx
  ON customer_live_location_sessions(tenant_id,store_id,status,updated_at DESC);

ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_location_source_check;
ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_location_source_check
  CHECK (location_source IS NULL OR location_source IN ('GPS','MAP_PIN','ADDRESS'));
ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_latitude_check;
ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_latitude_check CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_longitude_check;
ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_longitude_check CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

ALTER TABLE order_addresses DROP CONSTRAINT IF EXISTS order_addresses_location_source_check;
ALTER TABLE order_addresses ADD CONSTRAINT order_addresses_location_source_check
  CHECK (location_source IS NULL OR location_source IN ('GPS','MAP_PIN','ADDRESS'));
ALTER TABLE order_addresses DROP CONSTRAINT IF EXISTS order_addresses_latitude_check;
ALTER TABLE order_addresses ADD CONSTRAINT order_addresses_latitude_check CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
ALTER TABLE order_addresses DROP CONSTRAINT IF EXISTS order_addresses_longitude_check;
ALTER TABLE order_addresses ADD CONSTRAINT order_addresses_longitude_check CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);


ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_accuracy_check;
ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_accuracy_check CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0);
ALTER TABLE order_addresses DROP CONSTRAINT IF EXISTS order_addresses_accuracy_check;
ALTER TABLE order_addresses ADD CONSTRAINT order_addresses_accuracy_check CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0);


CREATE TABLE IF NOT EXISTS platform_status_visual_packs (
  key text PRIMARY KEY,
  name text NOT NULL,
  business_type text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  icons jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_status_visual_packs(key,name,business_type,status,icons,settings) VALUES
('MODERN','Modern','GENERAL','ACTIVE','{"PENDING":"clock","PENDING_PAYMENT":"clock","PAYMENT_FAILED":"alert-triangle","PAID":"check-circle","CONFIRMED":"check-circle","PROCESSING":"cog","RESTAURANT_ACCEPTED":"check-circle","PREPARING":"package","READY":"shopping-bag","SHIPPED":"package","OUT_FOR_DELIVERY":"truck","PICKED_UP":"shopping-bag","DELIVERED":"package-check","COMPLETED":"check-circle","FULFILLED":"check-circle","FAILED":"alert-triangle","CANCELLED":"x-circle","REFUNDED":"x-circle","ACCESS_GRANTED":"unlock","AVAILABLE":"sparkles","DOWNLOADED":"download"}'::jsonb,'{}'::jsonb),
('FASHION_LUXURY','Fashion Luxury','FASHION','ACTIVE','{"PENDING":"clock","PENDING_PAYMENT":"clock","PAYMENT_FAILED":"alert-triangle","PAID":"check-circle","CONFIRMED":"check-circle","PROCESSING":"cog","RESTAURANT_ACCEPTED":"check-circle","PREPARING":"shopping-bag","READY":"shopping-bag","SHIPPED":"gift","OUT_FOR_DELIVERY":"truck","PICKED_UP":"shopping-bag","DELIVERED":"gift","COMPLETED":"check-circle","FULFILLED":"check-circle","FAILED":"alert-triangle","CANCELLED":"x-circle","REFUNDED":"x-circle","ACCESS_GRANTED":"unlock","AVAILABLE":"sparkles","DOWNLOADED":"download"}'::jsonb,'{}'::jsonb),
('RESTAURANT_MODERN','Restaurant Modern','RESTAURANT','ACTIVE','{"PENDING":"receipt","PENDING_PAYMENT":"receipt","PAYMENT_FAILED":"alert-triangle","PAID":"check-circle","CONFIRMED":"check-circle","PROCESSING":"cog","RESTAURANT_ACCEPTED":"check-circle","PREPARING":"chef-hat","READY":"shopping-bag","SHIPPED":"package","OUT_FOR_DELIVERY":"scooter","PICKED_UP":"shopping-bag","DELIVERED":"home","COMPLETED":"check-circle","FULFILLED":"check-circle","FAILED":"alert-triangle","CANCELLED":"x-circle","REFUNDED":"x-circle","ACCESS_GRANTED":"unlock","AVAILABLE":"sparkles","DOWNLOADED":"download"}'::jsonb,'{}'::jsonb),
('ELECTRONICS_PRO','Electronics Pro','ELECTRONICS','ACTIVE','{"PENDING":"radar","PENDING_PAYMENT":"radar","PAYMENT_FAILED":"alert-triangle","PAID":"check-circle","CONFIRMED":"check-circle","PROCESSING":"cog","RESTAURANT_ACCEPTED":"check-circle","PREPARING":"cog","READY":"package","SHIPPED":"package","OUT_FOR_DELIVERY":"truck","PICKED_UP":"shopping-bag","DELIVERED":"package-check","COMPLETED":"check-circle","FULFILLED":"check-circle","FAILED":"alert-triangle","CANCELLED":"x-circle","REFUNDED":"x-circle","ACCESS_GRANTED":"unlock","AVAILABLE":"sparkles","DOWNLOADED":"download"}'::jsonb,'{}'::jsonb),
('GROCERY_CLEAN','Grocery Clean','GROCERY','ACTIVE','{"PENDING":"clock","PENDING_PAYMENT":"clock","PAYMENT_FAILED":"alert-triangle","PAID":"check-circle","CONFIRMED":"check-circle","PROCESSING":"cog","RESTAURANT_ACCEPTED":"check-circle","PREPARING":"shopping-bag","READY":"shopping-bag","SHIPPED":"package","OUT_FOR_DELIVERY":"truck","PICKED_UP":"shopping-bag","DELIVERED":"package-check","COMPLETED":"check-circle","FULFILLED":"check-circle","FAILED":"alert-triangle","CANCELLED":"x-circle","REFUNDED":"x-circle","ACCESS_GRANTED":"unlock","AVAILABLE":"sparkles","DOWNLOADED":"download"}'::jsonb,'{}'::jsonb),
('DIGITAL_CREATOR','Digital Creator','DIGITAL','ACTIVE','{"PENDING":"clock","PENDING_PAYMENT":"clock","PAYMENT_FAILED":"alert-triangle","PAID":"check-circle","CONFIRMED":"check-circle","PROCESSING":"cog","RESTAURANT_ACCEPTED":"check-circle","PREPARING":"unlock","READY":"unlock","SHIPPED":"package","OUT_FOR_DELIVERY":"truck","PICKED_UP":"shopping-bag","DELIVERED":"download","COMPLETED":"check-circle","FULFILLED":"check-circle","FAILED":"alert-triangle","CANCELLED":"x-circle","REFUNDED":"x-circle","ACCESS_GRANTED":"unlock","AVAILABLE":"sparkles","DOWNLOADED":"download"}'::jsonb,'{}'::jsonb)
ON CONFLICT (key) DO NOTHING;


-- Platform-owned fulfillment visual defaults. The semantic fulfillment status remains
-- unchanged; this only seeds the visual pack used by Customer Web.
UPDATE platform_storefront_templates
SET config = jsonb_set(
  config,
  '{status_visual_pack}',
  to_jsonb(CASE
    WHEN business_type='FASHION' THEN 'FASHION_LUXURY'
    WHEN business_type='RESTAURANT' THEN 'RESTAURANT_MODERN'
    WHEN business_type='ELECTRONICS' THEN 'ELECTRONICS_PRO'
    WHEN business_type='GROCERY' THEN 'GROCERY_CLEAN'
    WHEN business_type='DIGITAL' THEN 'DIGITAL_CREATOR'
    ELSE 'MODERN'
  END),
  true
), updated_at=now()
WHERE NOT (config ? 'status_visual_pack') OR COALESCE(config->>'status_visual_pack','') IN ('','AUTO');

-- Existing drafts/published versions stay backwards compatible. AUTO means use the
-- template/theme-derived default until the merchant explicitly chooses a pack.
UPDATE storefront_experience_versions
SET config = jsonb_set(config,'{status_visual_pack}','"AUTO"'::jsonb,true), updated_at=now()
WHERE NOT (config ? 'status_visual_pack');
