-- Shope / Luke Shop Backend — Driver Mobile Pro v1
-- Additive migration. Migrations 001-028 remain immutable.
--
-- Provides store-level Driver App policy, driver availability/presence state,
-- immutable presence events and per-driver language preference. Existing stores
-- remain compatible because assignment restrictions are disabled by default.

ALTER TABLE delivery_drivers
  ADD COLUMN availability_status text NOT NULL DEFAULT 'OFFLINE'
    CHECK (availability_status IN ('ONLINE','BREAK','OFFLINE')),
  ADD COLUMN preferred_locale text NOT NULL DEFAULT 'en',
  ADD COLUMN availability_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_seen_at timestamptz;

CREATE INDEX delivery_drivers_availability_idx
  ON delivery_drivers(tenant_id,store_id,status,availability_status,updated_at DESC);

CREATE TABLE delivery_driver_app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  require_online_for_assignment boolean NOT NULL DEFAULT false,
  max_active_jobs integer NOT NULL DEFAULT 3 CHECK (max_active_jobs BETWEEN 1 AND 25),
  location_mode text NOT NULL DEFAULT 'AUTO_ON_START_DELIVERY'
    CHECK (location_mode IN ('AUTO_ON_START_DELIVERY','MANUAL')),
  location_update_seconds integer NOT NULL DEFAULT 10 CHECK (location_update_seconds BETWEEN 5 AND 120),
  tracking_stale_seconds integer NOT NULL DEFAULT 45 CHECK (tracking_stale_seconds BETWEEN 15 AND 600),
  proof_policy text NOT NULL DEFAULT 'ANY'
    CHECK (proof_policy IN ('ANY','ACKNOWLEDGEMENT','PHOTO','PHOTO_AND_ACKNOWLEDGEMENT')),
  cod_enabled boolean NOT NULL DEFAULT true,
  max_cod_held numeric(18,4) CHECK (max_cod_held IS NULL OR max_cod_held >= 0),
  allow_customer_call boolean NOT NULL DEFAULT true,
  allow_customer_chat boolean NOT NULL DEFAULT true,
  allow_store_chat boolean NOT NULL DEFAULT true,
  chat_close_minutes integer NOT NULL DEFAULT 60 CHECK (chat_close_minutes BETWEEN 0 AND 10080),
  quick_replies jsonb NOT NULL DEFAULT '["I am on my way.","I have arrived.","I cannot find your location.","Please come to the entrance.","There is a small delay."]'::jsonb,
  supported_locales text[] NOT NULL DEFAULT ARRAY['en','my'],
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,created_by) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,updated_by) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  CHECK (jsonb_typeof(quick_replies)='array')
);

CREATE TABLE delivery_driver_presence_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  from_status text CHECK (from_status IS NULL OR from_status IN ('ONLINE','BREAK','OFFLINE')),
  to_status text NOT NULL CHECK (to_status IN ('ONLINE','BREAK','OFFLINE')),
  actor_type text NOT NULL CHECK (actor_type IN ('DRIVER','MERCHANT','SYSTEM')),
  actor_id uuid,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,driver_id) REFERENCES delivery_drivers(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX delivery_driver_presence_events_idx
  ON delivery_driver_presence_events(tenant_id,store_id,driver_id,created_at DESC,id DESC);
