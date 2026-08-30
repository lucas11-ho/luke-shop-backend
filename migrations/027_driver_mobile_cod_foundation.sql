-- Shope / Luke Shop Backend — Driver Mobile & COD v1
-- Additive migration. Migrations 001-026 remain immutable.
--
-- Driver access continues to authenticate through a linked active merchant user,
-- but driver-scoped routes never inherit broad Merchant Admin permissions.
-- Cash collected by a driver is custody evidence only; merchant reconciliation
-- remains a separate audited financial action.

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check
  CHECK (actor_type IN ('CUSTOMER','MERCHANT','PLATFORM','SYSTEM','LUKE_CS','DRIVER'));

ALTER TABLE fulfillment_status_history DROP CONSTRAINT IF EXISTS fulfillment_status_history_actor_type_check;
ALTER TABLE fulfillment_status_history ADD CONSTRAINT fulfillment_status_history_actor_type_check
  CHECK (actor_type IN ('CUSTOMER','MERCHANT','PLATFORM','SYSTEM','LUKE_CS','DRIVER'));

ALTER TABLE delivery_dispatches
  ADD COLUMN current_latitude double precision,
  ADD COLUMN current_longitude double precision,
  ADD COLUMN current_accuracy_meters double precision,
  ADD COLUMN location_updated_at timestamptz,
  ADD CONSTRAINT delivery_dispatch_location_check CHECK (
    (current_latitude IS NULL AND current_longitude IS NULL)
    OR (current_latitude BETWEEN -90 AND 90 AND current_longitude BETWEEN -180 AND 180)
  ),
  ADD CONSTRAINT delivery_dispatch_accuracy_check CHECK (
    current_accuracy_meters IS NULL OR current_accuracy_meters >= 0
  );

CREATE TABLE delivery_driver_location_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters double precision CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,dispatch_id) REFERENCES delivery_dispatches(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,driver_id) REFERENCES delivery_drivers(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX delivery_driver_location_dispatch_idx
  ON delivery_driver_location_events(tenant_id,store_id,dispatch_id,created_at DESC,id DESC);

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_tenant_store_id_uq UNIQUE(tenant_id,store_id,id);

CREATE TABLE delivery_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  proof_type text NOT NULL CHECK (proof_type IN ('ACKNOWLEDGEMENT','PHOTO')),
  recipient_name text,
  note text,
  asset_id uuid,
  created_by uuid,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,dispatch_id) REFERENCES delivery_dispatches(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,driver_id) REFERENCES delivery_drivers(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,asset_id) REFERENCES media_assets(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  CHECK (
    (proof_type='PHOTO' AND asset_id IS NOT NULL)
    OR
    (proof_type='ACKNOWLEDGEMENT' AND asset_id IS NULL AND (NULLIF(btrim(recipient_name),'') IS NOT NULL OR NULLIF(btrim(note),'') IS NOT NULL))
  )
);
CREATE INDEX delivery_proofs_dispatch_idx
  ON delivery_proofs(tenant_id,store_id,dispatch_id,created_at,id);

CREATE TABLE delivery_cod_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'COLLECTED' CHECK (status IN ('COLLECTED','REMITTED','RECONCILED')),
  currency char(3) NOT NULL,
  expected_amount numeric(18,4) NOT NULL CHECK (expected_amount >= 0),
  collected_amount numeric(18,4) NOT NULL CHECK (collected_amount >= 0),
  collection_note text,
  remittance_note text,
  reconciliation_note text,
  collected_at timestamptz NOT NULL DEFAULT now(),
  remitted_at timestamptz,
  reconciled_at timestamptz,
  remitted_by uuid,
  reconciled_by uuid,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,dispatch_id),
  FOREIGN KEY (tenant_id,store_id,dispatch_id) REFERENCES delivery_dispatches(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,payment_id) REFERENCES order_payments(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,driver_id) REFERENCES delivery_drivers(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,remitted_by) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,reconciled_by) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  CHECK (collected_amount = expected_amount)
);
CREATE INDEX delivery_cod_collections_status_idx
  ON delivery_cod_collections(tenant_id,store_id,status,collected_at DESC);
CREATE INDEX delivery_cod_collections_driver_idx
  ON delivery_cod_collections(tenant_id,store_id,driver_id,status,collected_at DESC);

CREATE TABLE delivery_cod_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('COLLECTED','REMITTED','RECONCILED')),
  actor_type text NOT NULL CHECK (actor_type IN ('DRIVER','MERCHANT','SYSTEM')),
  actor_id uuid,
  amount numeric(18,4) CHECK (amount IS NULL OR amount >= 0),
  note text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,collection_id) REFERENCES delivery_cod_collections(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX delivery_cod_events_collection_idx
  ON delivery_cod_events(tenant_id,store_id,collection_id,created_at,id);
