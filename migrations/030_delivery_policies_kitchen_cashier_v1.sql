-- Shope / Luke Shop Backend — Delivery Settings & Policies v2 + Kitchen/Cashier Operations v1
-- Additive migration. Migrations 001-029 remain immutable.

-- Dedicated least-privilege operational permissions.
INSERT INTO merchant_permissions(key,description) VALUES
('kitchen.read','Read the store kitchen production queue'),
('kitchen.manage','Accept, prepare and mark food orders ready'),
('cashier.read','Read cashier order, payment and COD handover queues'),
('cashier.manage','Confirm eligible manual payments and receive COD cash handovers')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO merchant_role_permissions(role_id,permission_key)
SELECT r.id,p.key FROM merchant_roles r JOIN merchant_permissions p ON p.key IN ('kitchen.read','kitchen.manage','cashier.read','cashier.manage')
WHERE r.key='OWNER'
ON CONFLICT DO NOTHING;

-- Purpose-built system roles for existing tenants. DRIVER intentionally has no
-- Merchant Admin permission; linked Driver App routes are assignment-scoped.
INSERT INTO merchant_roles(id,tenant_id,key,name,description,is_system)
SELECT gen_random_uuid(),t.id,'KITCHEN','Kitchen','Kitchen-only production workspace',true FROM tenants t
ON CONFLICT(tenant_id,key) DO NOTHING;
INSERT INTO merchant_roles(id,tenant_id,key,name,description,is_system)
SELECT gen_random_uuid(),t.id,'CASHIER','Cashier','Cashier payment and COD handover workspace',true FROM tenants t
ON CONFLICT(tenant_id,key) DO NOTHING;
INSERT INTO merchant_roles(id,tenant_id,key,name,description,is_system)
SELECT gen_random_uuid(),t.id,'DISPATCHER','Dispatcher','Delivery assignment and live operations workspace',true FROM tenants t
ON CONFLICT(tenant_id,key) DO NOTHING;
INSERT INTO merchant_roles(id,tenant_id,key,name,description,is_system)
SELECT gen_random_uuid(),t.id,'DRIVER','Driver','Dedicated Driver App identity with no broad Merchant Admin permissions',true FROM tenants t
ON CONFLICT(tenant_id,key) DO NOTHING;

INSERT INTO merchant_role_permissions(role_id,permission_key)
SELECT r.id,p.key FROM merchant_roles r JOIN merchant_permissions p ON
 (r.key='KITCHEN' AND p.key IN ('kitchen.read','kitchen.manage')) OR
 (r.key='CASHIER' AND p.key IN ('cashier.read','cashier.manage')) OR
 (r.key='DISPATCHER' AND p.key IN ('orders.read','delivery.read','delivery.manage'))
ON CONFLICT DO NOTHING;

-- Ensure tenants provisioned after migration 030 receive the same fixed role templates.
CREATE OR REPLACE FUNCTION provision_delivery_operational_roles()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE role_id uuid;
BEGIN
  INSERT INTO merchant_roles(id,tenant_id,key,name,description,is_system) VALUES(gen_random_uuid(),NEW.id,'KITCHEN','Kitchen','Kitchen-only production workspace',true) ON CONFLICT(tenant_id,key) DO NOTHING;
  INSERT INTO merchant_roles(id,tenant_id,key,name,description,is_system) VALUES(gen_random_uuid(),NEW.id,'CASHIER','Cashier','Cashier payment and COD handover workspace',true) ON CONFLICT(tenant_id,key) DO NOTHING;
  INSERT INTO merchant_roles(id,tenant_id,key,name,description,is_system) VALUES(gen_random_uuid(),NEW.id,'DISPATCHER','Dispatcher','Delivery assignment and live operations workspace',true) ON CONFLICT(tenant_id,key) DO NOTHING;
  INSERT INTO merchant_roles(id,tenant_id,key,name,description,is_system) VALUES(gen_random_uuid(),NEW.id,'DRIVER','Driver','Dedicated Driver App identity with no broad Merchant Admin permissions',true) ON CONFLICT(tenant_id,key) DO NOTHING;
  FOR role_id IN SELECT id FROM merchant_roles WHERE tenant_id=NEW.id AND key='KITCHEN' LOOP
    INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES(role_id,'kitchen.read'),(role_id,'kitchen.manage') ON CONFLICT DO NOTHING;
  END LOOP;
  FOR role_id IN SELECT id FROM merchant_roles WHERE tenant_id=NEW.id AND key='CASHIER' LOOP
    INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES(role_id,'cashier.read'),(role_id,'cashier.manage') ON CONFLICT DO NOTHING;
  END LOOP;
  FOR role_id IN SELECT id FROM merchant_roles WHERE tenant_id=NEW.id AND key='DISPATCHER' LOOP
    INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES(role_id,'orders.read'),(role_id,'delivery.read'),(role_id,'delivery.manage') ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_delivery_operational_roles_trg
AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION provision_delivery_operational_roles();

-- Store policy is inactive-by-default for time-window enforcement so an existing
-- store does not change checkout behavior merely because migration 030 is applied.
CREATE TABLE delivery_store_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  delivery_enabled boolean NOT NULL DEFAULT true,
  enforce_operating_hours boolean NOT NULL DEFAULT false,
  operating_hours jsonb NOT NULL DEFAULT '{"mon":[{"open":"00:00","close":"23:59"}],"tue":[{"open":"00:00","close":"23:59"}],"wed":[{"open":"00:00","close":"23:59"}],"thu":[{"open":"00:00","close":"23:59"}],"fri":[{"open":"00:00","close":"23:59"}],"sat":[{"open":"00:00","close":"23:59"}],"sun":[{"open":"00:00","close":"23:59"}]}'::jsonb,
  same_day_cutoff_local time,
  default_prep_minutes integer NOT NULL DEFAULT 20 CHECK(default_prep_minutes BETWEEN 0 AND 480),
  require_ready_before_dispatch boolean NOT NULL DEFAULT false,
  kitchen_enabled boolean NOT NULL DEFAULT true,
  cashier_enabled boolean NOT NULL DEFAULT true,
  kitchen_payment_policy text NOT NULL DEFAULT 'PAID_OR_COD' CHECK(kitchen_payment_policy IN ('PAID_OR_COD','ANY')),
  temporary_closure_message text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,created_by) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY(tenant_id,updated_by) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  CHECK(jsonb_typeof(operating_hours)='object'),
  CHECK(temporary_closure_message IS NULL OR char_length(temporary_closure_message)<=500)
);

-- Kitchen state is intentionally independent from financial order status so COD
-- food can be prepared while payment remains PENDING until driver cash reconciliation.
CREATE TABLE kitchen_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','ACCEPTED','PREPARING','READY','CANCELLED')),
  note text,
  accepted_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,fulfillment_id),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,store_id,fulfillment_id) REFERENCES order_fulfillments(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,updated_by) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  CHECK(note IS NULL OR char_length(note)<=1000)
);
CREATE INDEX kitchen_jobs_queue_idx ON kitchen_jobs(tenant_id,store_id,status,created_at,id);

CREATE OR REPLACE FUNCTION sync_food_kitchen_job()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mapped text;
BEGIN
  IF NEW.fulfillment_type NOT IN ('FOOD_DELIVERY','FOOD_PICKUP') THEN RETURN NEW; END IF;
  mapped:=CASE
    WHEN NEW.status='PENDING' THEN 'NEW'
    WHEN NEW.status='PREPARING' THEN 'PREPARING'
    WHEN NEW.status='READY' THEN 'READY'
    WHEN NEW.status IN ('CANCELLED','FAILED') THEN 'CANCELLED'
    ELSE 'READY'
  END;
  INSERT INTO kitchen_jobs(public_id,tenant_id,store_id,order_id,fulfillment_id,status,preparing_at,ready_at)
  VALUES('kit_'||encode(gen_random_bytes(12),'hex'),NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.id,mapped,
    CASE WHEN mapped='PREPARING' THEN now() ELSE NULL END,
    CASE WHEN mapped='READY' THEN now() ELSE NULL END)
  ON CONFLICT(tenant_id,store_id,fulfillment_id) DO UPDATE SET
    status=CASE
      WHEN EXCLUDED.status='CANCELLED' THEN 'CANCELLED'
      WHEN EXCLUDED.status='READY' THEN 'READY'
      WHEN EXCLUDED.status='PREPARING' AND kitchen_jobs.status IN ('NEW','ACCEPTED') THEN 'PREPARING'
      ELSE kitchen_jobs.status END,
    preparing_at=CASE WHEN EXCLUDED.status='PREPARING' THEN COALESCE(kitchen_jobs.preparing_at,now()) ELSE kitchen_jobs.preparing_at END,
    ready_at=CASE WHEN EXCLUDED.status='READY' THEN COALESCE(kitchen_jobs.ready_at,now()) ELSE kitchen_jobs.ready_at END,
    updated_at=now();
  RETURN NEW;
END $$;
CREATE TRIGGER order_fulfillment_kitchen_job_trg
AFTER INSERT OR UPDATE OF status ON order_fulfillments
FOR EACH ROW EXECUTE FUNCTION sync_food_kitchen_job();

INSERT INTO kitchen_jobs(public_id,tenant_id,store_id,order_id,fulfillment_id,status,preparing_at,ready_at)
SELECT 'kit_'||encode(gen_random_bytes(12),'hex'),f.tenant_id,f.store_id,f.order_id,f.id,
 CASE WHEN f.status='PENDING' THEN 'NEW' WHEN f.status='PREPARING' THEN 'PREPARING' WHEN f.status='READY' THEN 'READY' WHEN f.status IN ('CANCELLED','FAILED') THEN 'CANCELLED' ELSE 'READY' END,
 CASE WHEN f.status='PREPARING' THEN COALESCE(f.updated_at,now()) ELSE NULL END,
 CASE WHEN f.status IN ('READY','OUT_FOR_DELIVERY','PICKED_UP','DELIVERED','COMPLETED') THEN COALESCE(f.updated_at,now()) ELSE NULL END
FROM order_fulfillments f
WHERE f.fulfillment_type IN ('FOOD_DELIVERY','FOOD_PICKUP')
ON CONFLICT(tenant_id,store_id,fulfillment_id) DO NOTHING;

-- Final checkout authority: when a store explicitly saves delivery policies, order
-- fulfillment creation enforces enabled/open/cutoff state inside the transaction.
CREATE OR REPLACE FUNCTION enforce_delivery_store_order_window()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg delivery_store_settings%ROWTYPE; tz text; local_day text; local_time text; open_now boolean;
BEGIN
  IF NEW.fulfillment_type NOT IN ('PHYSICAL_SHIPPING','PHYSICAL_LOCAL_DELIVERY','PHYSICAL_PICKUP','FOOD_DELIVERY','FOOD_PICKUP') THEN RETURN NEW; END IF;
  SELECT * INTO cfg FROM delivery_store_settings WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT cfg.delivery_enabled THEN RAISE EXCEPTION 'Delivery and pickup ordering is disabled for this store' USING ERRCODE='23514',CONSTRAINT='delivery_store_disabled'; END IF;
  IF NOT cfg.enforce_operating_hours AND cfg.same_day_cutoff_local IS NULL THEN RETURN NEW; END IF;
  SELECT timezone INTO tz FROM tenant_settings WHERE tenant_id=NEW.tenant_id;
  local_day:=lower(to_char(now() AT TIME ZONE COALESCE(tz,'UTC'),'Dy'));
  local_time:=to_char(now() AT TIME ZONE COALESCE(tz,'UTC'),'HH24:MI');
  IF cfg.enforce_operating_hours THEN
    SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(cfg.operating_hours->local_day,'[]'::jsonb)) w WHERE local_time>=w->>'open' AND local_time<=w->>'close') INTO open_now;
    IF NOT open_now THEN RAISE EXCEPTION 'Store is outside delivery and pickup operating hours' USING ERRCODE='23514',CONSTRAINT='delivery_store_closed'; END IF;
  END IF;
  IF cfg.same_day_cutoff_local IS NOT NULL AND local_time>to_char(cfg.same_day_cutoff_local,'HH24:MI') THEN RAISE EXCEPTION 'Same-day delivery and pickup cutoff has passed' USING ERRCODE='23514',CONSTRAINT='delivery_store_cutoff'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_fulfillment_delivery_store_window_trg
BEFORE INSERT ON order_fulfillments FOR EACH ROW EXECUTE FUNCTION enforce_delivery_store_order_window();

-- Optional owner policy: dispatch assignment can be forced to wait for READY.
CREATE OR REPLACE FUNCTION enforce_ready_before_dispatch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg delivery_store_settings%ROWTYPE; fulfillment_status text;
BEGIN
  SELECT * INTO cfg FROM delivery_store_settings WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id;
  IF NOT FOUND OR NOT cfg.require_ready_before_dispatch THEN RETURN NEW; END IF;
  SELECT status INTO fulfillment_status FROM order_fulfillments WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.fulfillment_id;
  IF fulfillment_status IS DISTINCT FROM 'READY' THEN RAISE EXCEPTION 'Fulfillment must be READY before driver assignment' USING ERRCODE='23514',CONSTRAINT='delivery_dispatch_requires_ready'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_dispatch_ready_policy_trg
BEFORE INSERT OR UPDATE OF fulfillment_id ON delivery_dispatches FOR EACH ROW EXECUTE FUNCTION enforce_ready_before_dispatch();
