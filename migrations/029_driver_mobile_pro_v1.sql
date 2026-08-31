-- Shope / Luke Shop Backend — Driver Mobile Pro v1
-- Additive migration. Migrations 001-028 remain immutable.
--
-- Provides store-level Driver App policy, driver availability/presence state,
-- immutable presence events and per-driver language preference. Existing stores
-- remain compatible because policy enforcement activates only after a store saves
-- a Driver App settings row.

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

-- Assignment policy is enforced in the database so Merchant Admin cannot bypass it.
CREATE OR REPLACE FUNCTION enforce_driver_app_assignment_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg delivery_driver_app_settings%ROWTYPE; drv delivery_drivers%ROWTYPE; active_count integer;
BEGIN
  IF TG_OP='UPDATE' AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id THEN RETURN NEW; END IF;
  SELECT * INTO cfg FROM delivery_driver_app_settings WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT cfg.enabled THEN
    RAISE EXCEPTION 'Driver App is disabled for this store' USING ERRCODE='23514',CONSTRAINT='driver_app_disabled_assignment';
  END IF;
  SELECT * INTO drv FROM delivery_drivers WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.driver_id;
  IF cfg.require_online_for_assignment AND drv.availability_status<>'ONLINE' THEN
    RAISE EXCEPTION 'Driver must be online before assignment' USING ERRCODE='23514',CONSTRAINT='driver_app_online_assignment';
  END IF;
  SELECT count(*) INTO active_count FROM delivery_dispatches
   WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND driver_id=NEW.driver_id
     AND status NOT IN ('DELIVERED','CANCELLED') AND id<>NEW.id;
  IF active_count>=cfg.max_active_jobs THEN
    RAISE EXCEPTION 'Driver has reached maximum active jobs' USING ERRCODE='23514',CONSTRAINT='driver_app_max_active_jobs';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_dispatch_driver_app_policy_trg
  BEFORE INSERT OR UPDATE OF driver_id ON delivery_dispatches
  FOR EACH ROW EXECUTE FUNCTION enforce_driver_app_assignment_policy();

-- Proof policy is checked independently of the browser before DELIVERED is persisted.
CREATE OR REPLACE FUNCTION enforce_driver_app_proof_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg delivery_driver_app_settings%ROWTYPE; ack_count integer; photo_count integer;
BEGIN
  IF NEW.status<>'DELIVERED' OR (TG_OP='UPDATE' AND OLD.status='DELIVERED') THEN RETURN NEW; END IF;
  SELECT * INTO cfg FROM delivery_driver_app_settings WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT count(*) FILTER(WHERE proof_type='ACKNOWLEDGEMENT'),count(*) FILTER(WHERE proof_type='PHOTO')
    INTO ack_count,photo_count FROM delivery_proofs WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND dispatch_id=NEW.id;
  IF cfg.proof_policy='ACKNOWLEDGEMENT' AND ack_count=0 THEN
    RAISE EXCEPTION 'Receiver acknowledgement is required' USING ERRCODE='23514',CONSTRAINT='driver_app_ack_required';
  ELSIF cfg.proof_policy='PHOTO' AND photo_count=0 THEN
    RAISE EXCEPTION 'Delivery photo is required' USING ERRCODE='23514',CONSTRAINT='driver_app_photo_required';
  ELSIF cfg.proof_policy='PHOTO_AND_ACKNOWLEDGEMENT' AND (ack_count=0 OR photo_count=0) THEN
    RAISE EXCEPTION 'Delivery photo and acknowledgement are required' USING ERRCODE='23514',CONSTRAINT='driver_app_photo_ack_required';
  ELSIF cfg.proof_policy='ANY' AND ack_count=0 AND photo_count=0 THEN
    RAISE EXCEPTION 'Delivery proof is required' USING ERRCODE='23514',CONSTRAINT='driver_app_any_proof_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_dispatch_driver_app_proof_trg
  BEFORE UPDATE OF status ON delivery_dispatches
  FOR EACH ROW EXECUTE FUNCTION enforce_driver_app_proof_policy();

-- COD custody policy prevents a driver from exceeding the store's configured cash exposure.
CREATE OR REPLACE FUNCTION enforce_driver_app_cod_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg delivery_driver_app_settings%ROWTYPE; held numeric(18,4);
BEGIN
  SELECT * INTO cfg FROM delivery_driver_app_settings WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT cfg.cod_enabled THEN
    RAISE EXCEPTION 'COD collection is disabled in Driver App' USING ERRCODE='23514',CONSTRAINT='driver_app_cod_disabled';
  END IF;
  IF cfg.max_cod_held IS NOT NULL THEN
    SELECT COALESCE(sum(collected_amount),0) INTO held FROM delivery_cod_collections
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND driver_id=NEW.driver_id AND status='COLLECTED';
    IF held+NEW.collected_amount>cfg.max_cod_held THEN
      RAISE EXCEPTION 'Driver cash-held limit exceeded' USING ERRCODE='23514',CONSTRAINT='driver_app_cod_limit';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_cod_driver_app_policy_trg
  BEFORE INSERT ON delivery_cod_collections
  FOR EACH ROW EXECUTE FUNCTION enforce_driver_app_cod_policy();

-- The current v1 conversation is shared by Customer / Driver / Store. Turning off
-- customer chat makes customer/driver participation read-only while Merchant may
-- still send operational notices. Separate Driver↔Store channels are a later slice.
CREATE OR REPLACE FUNCTION enforce_driver_app_chat_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg delivery_driver_app_settings%ROWTYPE;
BEGIN
  IF NEW.sender_type NOT IN ('CUSTOMER','DRIVER') THEN RETURN NEW; END IF;
  SELECT * INTO cfg FROM delivery_driver_app_settings WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id;
  IF FOUND AND NOT cfg.allow_customer_chat THEN
    RAISE EXCEPTION 'Customer and driver delivery chat is disabled' USING ERRCODE='23514',CONSTRAINT='driver_app_customer_chat_disabled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_messages_driver_app_policy_trg
  BEFORE INSERT ON delivery_messages
  FOR EACH ROW EXECUTE FUNCTION enforce_driver_app_chat_policy();
