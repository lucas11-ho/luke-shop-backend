-- Shope / Luke Shop Backend — Delivery Operations Foundation v1
-- Additive migration. Migrations 001-024 remain immutable.
--
-- This migration persists delivery-zone/rate configuration, a store-scoped driver
-- directory, and audited dispatch assignments. Zone rates are intentionally NOT
-- wired into checkout by this migration; checkout continues to use the existing
-- delivery_methods pricing contract until the separately tested quote resolver is
-- promoted.

CREATE TABLE delivery_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  match_type text NOT NULL CHECK (match_type IN ('COUNTRY_REGION','RADIUS')),
  country_codes text[] NOT NULL DEFAULT '{}',
  region_names text[] NOT NULL DEFAULT '{}',
  center_latitude double precision,
  center_longitude double precision,
  radius_km numeric(10,3),
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,code),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  CHECK (
    (match_type='COUNTRY_REGION'
      AND cardinality(country_codes)>0
      AND center_latitude IS NULL AND center_longitude IS NULL AND radius_km IS NULL)
    OR
    (match_type='RADIUS'
      AND center_latitude BETWEEN -90 AND 90
      AND center_longitude BETWEEN -180 AND 180
      AND radius_km>0)
  )
);
CREATE INDEX delivery_zones_store_status_idx
  ON delivery_zones(tenant_id,store_id,status,sort_order,created_at);

CREATE TABLE delivery_zone_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  zone_id uuid NOT NULL,
  delivery_method_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  flat_fee numeric(18,4) NOT NULL DEFAULT 0 CHECK (flat_fee>=0),
  free_over numeric(18,4) CHECK (free_over IS NULL OR free_over>=0),
  min_order numeric(18,4) NOT NULL DEFAULT 0 CHECK (min_order>=0),
  estimated_min_minutes integer CHECK (estimated_min_minutes IS NULL OR estimated_min_minutes>=0),
  estimated_max_minutes integer CHECK (estimated_max_minutes IS NULL OR estimated_max_minutes>=0),
  priority integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,zone_id,delivery_method_id),
  FOREIGN KEY (tenant_id,store_id,zone_id) REFERENCES delivery_zones(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,delivery_method_id) REFERENCES delivery_methods(tenant_id,store_id,id) ON DELETE CASCADE,
  CHECK (estimated_min_minutes IS NULL OR estimated_max_minutes IS NULL OR estimated_max_minutes>=estimated_min_minutes)
);
CREATE INDEX delivery_zone_rates_lookup_idx
  ON delivery_zone_rates(tenant_id,store_id,delivery_method_id,status,priority,created_at);

CREATE TABLE delivery_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  merchant_user_id uuid,
  display_name text NOT NULL,
  phone_e164 text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED')),
  vehicle_type text CHECK (vehicle_type IS NULL OR vehicle_type IN ('BIKE','MOTORBIKE','CAR','VAN','TRUCK','OTHER')),
  vehicle_label text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,merchant_user_id) REFERENCES merchant_users(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX delivery_drivers_merchant_user_uq
  ON delivery_drivers(tenant_id,store_id,merchant_user_id)
  WHERE merchant_user_id IS NOT NULL;
CREATE INDEX delivery_drivers_store_status_idx
  ON delivery_drivers(tenant_id,store_id,status,display_name,created_at);

CREATE TABLE delivery_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ASSIGNED'
    CHECK (status IN ('ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED','CANCELLED')),
  assigned_by uuid REFERENCES merchant_users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  picked_up_at timestamptz,
  out_for_delivery_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,fulfillment_id) REFERENCES order_fulfillments(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,driver_id) REFERENCES delivery_drivers(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX delivery_dispatches_one_active_fulfillment_idx
  ON delivery_dispatches(tenant_id,store_id,fulfillment_id)
  WHERE status NOT IN ('DELIVERED','CANCELLED');
CREATE INDEX delivery_dispatches_queue_idx
  ON delivery_dispatches(tenant_id,store_id,status,assigned_at DESC);
CREATE INDEX delivery_dispatches_driver_idx
  ON delivery_dispatches(tenant_id,store_id,driver_id,status,assigned_at DESC);

CREATE TABLE delivery_dispatch_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('ASSIGNED','REASSIGNED','STATUS_CHANGED','CANCELLED','NOTE')),
  actor_type text NOT NULL CHECK (actor_type IN ('MERCHANT','DRIVER','SYSTEM')),
  actor_id uuid,
  from_driver_id uuid,
  to_driver_id uuid,
  from_status text,
  to_status text,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,dispatch_id) REFERENCES delivery_dispatches(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,from_driver_id) REFERENCES delivery_drivers(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,to_driver_id) REFERENCES delivery_drivers(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX delivery_dispatch_events_dispatch_idx
  ON delivery_dispatch_events(tenant_id,store_id,dispatch_id,created_at,id);
