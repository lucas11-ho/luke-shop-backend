-- Shope / Luke Shop Backend — Delivery Tracking, Proof & Communication v1
-- Additive migration. Migrations 001-027 remain immutable.
--
-- This migration adds order-scoped delivery conversations, customer-safe proof
-- visibility, read markers, and merchant COD handover evidence. Driver GPS and
-- delivery proof capture remain owned by migration 027.

ALTER TABLE delivery_proofs
  ADD COLUMN customer_visible boolean NOT NULL DEFAULT true;

CREATE TABLE delivery_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','READ_ONLY','CLOSED')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  read_only_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,dispatch_id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,dispatch_id) REFERENCES delivery_dispatches(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX delivery_conversations_order_idx
  ON delivery_conversations(tenant_id,store_id,order_id,created_at DESC);

CREATE TABLE delivery_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_type text NOT NULL DEFAULT 'TEXT' CHECK (message_type IN ('TEXT','QUICK','SYSTEM')),
  sender_type text NOT NULL CHECK (sender_type IN ('CUSTOMER','DRIVER','MERCHANT','SYSTEM')),
  sender_customer_id uuid,
  sender_driver_id uuid,
  sender_merchant_user_id uuid,
  sender_name_snapshot text NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,conversation_id) REFERENCES delivery_conversations(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,sender_customer_id) REFERENCES customers(tenant_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,store_id,sender_driver_id) REFERENCES delivery_drivers(tenant_id,store_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,sender_merchant_user_id) REFERENCES merchant_users(tenant_id,id) ON DELETE SET NULL,
  CHECK (
    (sender_type='CUSTOMER' AND sender_customer_id IS NOT NULL AND sender_driver_id IS NULL AND sender_merchant_user_id IS NULL)
    OR (sender_type='DRIVER' AND sender_customer_id IS NULL AND sender_driver_id IS NOT NULL AND sender_merchant_user_id IS NOT NULL)
    OR (sender_type='MERCHANT' AND sender_customer_id IS NULL AND sender_driver_id IS NULL AND sender_merchant_user_id IS NOT NULL)
    OR (sender_type='SYSTEM' AND sender_customer_id IS NULL AND sender_driver_id IS NULL AND sender_merchant_user_id IS NULL)
  )
);
CREATE INDEX delivery_messages_conversation_idx
  ON delivery_messages(tenant_id,store_id,conversation_id,id);

CREATE TABLE delivery_conversation_reads (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  reader_type text NOT NULL CHECK (reader_type IN ('CUSTOMER','DRIVER','MERCHANT')),
  reader_id uuid NOT NULL,
  last_read_message_id bigint,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,store_id,conversation_id,reader_type,reader_id),
  FOREIGN KEY (tenant_id,store_id,conversation_id) REFERENCES delivery_conversations(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (last_read_message_id) REFERENCES delivery_messages(id) ON DELETE SET NULL
);

CREATE TABLE delivery_cod_handover_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  proof_type text NOT NULL CHECK (proof_type IN ('ACKNOWLEDGEMENT','PHOTO')),
  reference text,
  note text,
  asset_id uuid,
  created_by uuid NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,collection_id) REFERENCES delivery_cod_collections(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,asset_id) REFERENCES media_assets(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES merchant_users(tenant_id,id) ON DELETE RESTRICT,
  CHECK (
    (proof_type='PHOTO' AND asset_id IS NOT NULL)
    OR
    (proof_type='ACKNOWLEDGEMENT' AND asset_id IS NULL AND (NULLIF(btrim(reference),'') IS NOT NULL OR NULLIF(btrim(note),'') IS NOT NULL))
  )
);
CREATE INDEX delivery_cod_handover_proofs_collection_idx
  ON delivery_cod_handover_proofs(tenant_id,store_id,collection_id,created_at,id);
