-- Shope / Luke Shop Backend — Staff Web Push Notifications & Operational Reliability v1.4
-- Additive migration. Migrations 001-031 remain immutable.
-- Push is an advisory delivery channel only. Business/payment/COD/fulfillment state
-- remains authoritative in the existing domain tables and APIs.

INSERT INTO merchant_permissions(key,description) VALUES
('staff.notifications.read','Read Staff Web push notification settings and device summaries'),
('staff.notifications.manage','Manage Staff Web push notification settings')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO merchant_role_permissions(role_id,permission_key)
SELECT r.id,p.key FROM merchant_roles r
JOIN merchant_permissions p ON p.key IN ('staff.notifications.read','staff.notifications.manage')
WHERE r.key='OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE staff_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('sps_'||encode(gen_random_bytes(12),'hex')),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_user_id uuid NOT NULL,
  endpoint text NOT NULL,
  endpoint_hash char(64) NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  device_label text,
  user_agent text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED','EXPIRED')),
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,merchant_user_id) REFERENCES merchant_users(tenant_id,id) ON DELETE CASCADE,
  CHECK(length(endpoint) BETWEEN 16 AND 4096),
  CHECK(length(p256dh) BETWEEN 40 AND 512),
  CHECK(length(auth_secret) BETWEEN 8 AND 256),
  CHECK(device_label IS NULL OR length(device_label)<=120),
  CHECK(user_agent IS NULL OR length(user_agent)<=1000)
);
CREATE INDEX staff_push_subscriptions_user_idx ON staff_push_subscriptions(tenant_id,merchant_user_id,status,created_at DESC);

CREATE TABLE staff_push_preferences (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_user_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,merchant_user_id),
  FOREIGN KEY(tenant_id,merchant_user_id) REFERENCES merchant_users(tenant_id,id) ON DELETE CASCADE,
  CHECK(jsonb_typeof(categories)='object')
);

CREATE TABLE staff_push_store_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,store_id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  CHECK(jsonb_typeof(categories)='object')
);

CREATE TABLE staff_push_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE DEFAULT ('spo_'||encode(gen_random_bytes(12),'hex')),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  category text NOT NULL CHECK(category IN (
    'DRIVER_ASSIGNMENT','DRIVER_REASSIGNMENT','DISPATCH_CANCELLED','KITCHEN_NEW_ORDER',
    'KITCHEN_READY','CASHIER_ACTION','COD_RECONCILIATION','DISPATCH_MESSAGE'
  )),
  target_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  target_role_keys text[] NOT NULL DEFAULT '{}'::text[],
  target_permission_keys text[] NOT NULL DEFAULT '{}'::text[],
  permission_mode text NOT NULL DEFAULT 'ANY' CHECK(permission_mode IN ('ANY','ALL')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 280),
  route text NOT NULL CHECK(length(route) BETWEEN 1 AND 300),
  entity_type text,
  entity_ref text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','SENT','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  CHECK(cardinality(target_user_ids)>0 OR cardinality(target_role_keys)>0 OR cardinality(target_permission_keys)>0),
  CHECK(jsonb_typeof(payload)='object'),
  CHECK(entity_type IS NULL OR length(entity_type)<=80),
  CHECK(entity_ref IS NULL OR length(entity_ref)<=160),
  CHECK(dedupe_key IS NULL OR length(dedupe_key)<=220),
  CHECK(last_error IS NULL OR length(last_error)<=1000)
);
CREATE UNIQUE INDEX staff_push_outbox_dedupe_uidx ON staff_push_outbox(tenant_id,dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX staff_push_outbox_pending_idx ON staff_push_outbox(status,available_at,created_at) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX staff_push_outbox_tenant_store_idx ON staff_push_outbox(tenant_id,store_id,created_at DESC);

CREATE TABLE staff_push_delivery_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES staff_push_outbox(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES staff_push_subscriptions(id) ON DELETE SET NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_user_id uuid,
  delivery_status text NOT NULL CHECK(delivery_status IN ('DELIVERED','EXPIRED','FAILED','SKIPPED')),
  provider_status integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_push_delivery_log_event_idx ON staff_push_delivery_log(event_id,id);
CREATE INDEX staff_push_delivery_log_user_idx ON staff_push_delivery_log(tenant_id,merchant_user_id,created_at DESC);

-- updated_by / delivery-log actor references intentionally remain audit snapshots.
-- Avoid composite ON DELETE SET NULL foreign keys that could attempt to null tenant_id.

CREATE OR REPLACE FUNCTION enqueue_staff_push_event(
  p_tenant_id uuid,p_store_id uuid,p_category text,p_target_users uuid[],p_target_roles text[],
  p_target_permissions text[],p_permission_mode text,p_title text,p_body text,p_route text,
  p_entity_type text,p_entity_ref text,p_dedupe_key text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO staff_push_outbox(
    tenant_id,store_id,category,target_user_ids,target_role_keys,target_permission_keys,permission_mode,
    title,body,route,entity_type,entity_ref,dedupe_key
  ) VALUES(
    p_tenant_id,p_store_id,p_category,COALESCE(p_target_users,'{}'::uuid[]),COALESCE(p_target_roles,'{}'::text[]),
    COALESCE(p_target_permissions,'{}'::text[]),COALESCE(p_permission_mode,'ANY'),p_title,p_body,p_route,p_entity_type,p_entity_ref,p_dedupe_key
  ) ON CONFLICT DO NOTHING;
END $$;

-- Active in-transit work cannot be silently moved between drivers. A replacement
-- after pickup requires an explicit future recovery workflow instead of a casual selector change.
CREATE OR REPLACE FUNCTION guard_dispatch_in_transit_reassignment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id AND OLD.status IN ('PICKED_UP','OUT_FOR_DELIVERY') THEN
    RAISE EXCEPTION 'In-transit delivery cannot be reassigned' USING ERRCODE='23514',CONSTRAINT='delivery_dispatch_in_transit_reassign_forbidden';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_dispatch_in_transit_reassign_guard_trg
BEFORE UPDATE OF driver_id ON delivery_dispatches
FOR EACH ROW EXECUTE FUNCTION guard_dispatch_in_transit_reassignment();

CREATE OR REPLACE FUNCTION staff_push_dispatch_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE new_user uuid; old_user uuid;
BEGIN
  SELECT merchant_user_id INTO new_user FROM delivery_drivers WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.driver_id;
  IF TG_OP='INSERT' THEN
    IF new_user IS NOT NULL THEN
      PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'DRIVER_ASSIGNMENT',ARRAY[new_user],'{}','{}','ANY',
        'New delivery assignment','A delivery has been assigned to you. Open Staff Web to review.','/#/driver?dispatch='||NEW.public_id,
        'delivery_dispatch',NEW.public_id,'dispatch:'||NEW.public_id||':assigned:'||new_user::text);
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    SELECT merchant_user_id INTO old_user FROM delivery_drivers WHERE tenant_id=OLD.tenant_id AND store_id=OLD.store_id AND id=OLD.driver_id;
    IF old_user IS NOT NULL THEN
      PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'DRIVER_REASSIGNMENT',ARRAY[old_user],'{}','{}','ANY',
        'Delivery reassigned','A delivery assignment was moved to another driver.','/#/driver','delivery_dispatch',NEW.public_id,
        'dispatch:'||NEW.public_id||':reassigned-away:'||old_user::text);
    END IF;
    IF new_user IS NOT NULL THEN
      PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'DRIVER_REASSIGNMENT',ARRAY[new_user],'{}','{}','ANY',
        'New reassigned delivery','A delivery was reassigned to you. Open Staff Web to review.','/#/driver?dispatch='||NEW.public_id,
        'delivery_dispatch',NEW.public_id,'dispatch:'||NEW.public_id||':reassigned-to:'||new_user::text);
    END IF;
  END IF;
  IF NEW.status='CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' AND new_user IS NOT NULL THEN
    PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'DISPATCH_CANCELLED',ARRAY[new_user],'{}','{}','ANY',
      'Delivery assignment cancelled','A delivery assignment was cancelled. Open Staff Web for the latest queue.','/#/driver',
      'delivery_dispatch',NEW.public_id,'dispatch:'||NEW.public_id||':cancelled');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_dispatch_staff_push_trg
AFTER INSERT OR UPDATE ON delivery_dispatches
FOR EACH ROW EXECUTE FUNCTION staff_push_dispatch_trigger();

CREATE OR REPLACE FUNCTION staff_push_kitchen_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.status='NEW' THEN
    PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'KITCHEN_NEW_ORDER','{}',ARRAY['KITCHEN'],'{}','ANY',
      'New kitchen order','A new food order is ready for kitchen review.','/#/kitchen?job='||NEW.public_id,
      'kitchen_job',NEW.public_id,'kitchen:'||NEW.public_id||':new');
  ELSIF TG_OP='UPDATE' AND NEW.status='READY' AND OLD.status IS DISTINCT FROM 'READY' THEN
    PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'KITCHEN_READY','{}',ARRAY['DISPATCHER'],'{}','ANY',
      'Order ready for dispatch','Kitchen marked an order ready for dispatch.','/#/dispatcher',
      'kitchen_job',NEW.public_id,'kitchen:'||NEW.public_id||':ready');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kitchen_job_staff_push_trg
AFTER INSERT OR UPDATE ON kitchen_jobs
FOR EACH ROW EXECUTE FUNCTION staff_push_kitchen_trigger();

CREATE OR REPLACE FUNCTION staff_push_cod_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.status='COLLECTED' THEN
    PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'CASHIER_ACTION','{}',ARRAY['CASHIER'],'{}','ANY',
      'COD cash collected','A driver recorded COD cash that requires cashier custody.','/#/cashier',
      'cod_collection',NEW.public_id,'cod:'||NEW.public_id||':collected');
  ELSIF TG_OP='UPDATE' AND NEW.status='REMITTED' AND OLD.status IS DISTINCT FROM 'REMITTED' THEN
    PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'COD_RECONCILIATION','{}','{}',ARRAY['delivery.manage','payments.manage'],'ALL',
      'COD reconciliation required','COD cash was handed over and requires authorized reconciliation.','/#/cashier',
      'cod_collection',NEW.public_id,'cod:'||NEW.public_id||':remitted');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_cod_staff_push_trg
AFTER INSERT OR UPDATE ON delivery_cod_collections
FOR EACH ROW EXECUTE FUNCTION staff_push_cod_trigger();

CREATE OR REPLACE FUNCTION staff_push_delivery_message_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE driver_user uuid; dispatch_ref text;
BEGIN
  SELECT d.merchant_user_id,x.public_id INTO driver_user,dispatch_ref
  FROM delivery_conversations c
  JOIN delivery_dispatches x ON x.id=c.dispatch_id AND x.tenant_id=c.tenant_id AND x.store_id=c.store_id
  JOIN delivery_drivers d ON d.id=x.driver_id AND d.tenant_id=x.tenant_id AND d.store_id=x.store_id
  WHERE c.tenant_id=NEW.tenant_id AND c.store_id=NEW.store_id AND c.id=NEW.conversation_id;
  IF NEW.sender_type IN ('CUSTOMER','MERCHANT') AND driver_user IS NOT NULL THEN
    PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'DISPATCH_MESSAGE',ARRAY[driver_user],'{}','{}','ANY',
      'New delivery message','A delivery conversation has a new message. Open Staff Web to review.','/#/driver?dispatch='||COALESCE(dispatch_ref,''),
      'delivery_message',NEW.public_id,'message:'||NEW.public_id||':driver');
  END IF;
  IF NEW.sender_type IN ('CUSTOMER','DRIVER') THEN
    PERFORM enqueue_staff_push_event(NEW.tenant_id,NEW.store_id,'DISPATCH_MESSAGE','{}',ARRAY['DISPATCHER'],'{}','ANY',
      'New delivery message','A delivery conversation has a new message. Open Staff Web to review.','/#/dispatcher',
      'delivery_message',NEW.public_id,'message:'||NEW.public_id||':dispatcher');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_message_staff_push_trg
AFTER INSERT ON delivery_messages
FOR EACH ROW EXECUTE FUNCTION staff_push_delivery_message_trigger();
