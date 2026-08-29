-- Luke Shop Backend — Product Nature policy + secure digital entitlements
-- Additive. Existing incompatible fulfillment flags are normalized from the authoritative product_type.

-- Normalize legacy fulfillment combinations before enforcing the matrix.
DELETE FROM product_fulfillment_modes pfm
USING products p
WHERE p.id=pfm.product_id AND p.tenant_id=pfm.tenant_id AND p.store_id=pfm.store_id
  AND (
    (p.product_type='PHYSICAL' AND pfm.mode NOT IN ('SHIPPING','LOCAL_DELIVERY','PICKUP')) OR
    (p.product_type='FOOD' AND pfm.mode NOT IN ('LOCAL_DELIVERY','PICKUP')) OR
    (p.product_type IN ('DIGITAL_IMAGE','DIGITAL_VIDEO') AND pfm.mode NOT IN ('DIGITAL_ACCESS','DIGITAL_DOWNLOAD')) OR
    (p.product_type='SERVICE' AND pfm.mode<>'NONE')
  );

INSERT INTO product_fulfillment_modes(tenant_id,store_id,product_id,mode)
SELECT p.tenant_id,p.store_id,p.id,
  CASE p.product_type
    WHEN 'PHYSICAL' THEN 'SHIPPING'
    WHEN 'FOOD' THEN 'LOCAL_DELIVERY'
    WHEN 'DIGITAL_IMAGE' THEN 'DIGITAL_ACCESS'
    WHEN 'DIGITAL_VIDEO' THEN 'DIGITAL_ACCESS'
    ELSE 'NONE'
  END
FROM products p
WHERE NOT EXISTS(
  SELECT 1 FROM product_fulfillment_modes pfm
  WHERE pfm.tenant_id=p.tenant_id AND pfm.store_id=p.store_id AND pfm.product_id=p.id
)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_product_fulfillment_policy() RETURNS trigger AS $$
DECLARE ptype text;
BEGIN
  SELECT product_type INTO ptype FROM products
   WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.product_id;
  IF ptype IS NULL THEN RAISE EXCEPTION 'Product not found for fulfillment policy'; END IF;
  IF (ptype='PHYSICAL' AND NEW.mode NOT IN ('SHIPPING','LOCAL_DELIVERY','PICKUP'))
     OR (ptype='FOOD' AND NEW.mode NOT IN ('LOCAL_DELIVERY','PICKUP'))
     OR (ptype IN ('DIGITAL_IMAGE','DIGITAL_VIDEO') AND NEW.mode NOT IN ('DIGITAL_ACCESS','DIGITAL_DOWNLOAD'))
     OR (ptype='SERVICE' AND NEW.mode<>'NONE') THEN
    RAISE EXCEPTION 'Fulfillment mode % is incompatible with product type %', NEW.mode, ptype
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_fulfillment_policy_guard ON product_fulfillment_modes;
CREATE TRIGGER product_fulfillment_policy_guard
BEFORE INSERT OR UPDATE ON product_fulfillment_modes
FOR EACH ROW EXECUTE FUNCTION enforce_product_fulfillment_policy();

CREATE TABLE product_digital_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  access_mode text NOT NULL DEFAULT 'VIEW_ONLY' CHECK (access_mode IN ('VIEW_ONLY','DOWNLOAD_ONLY','VIEW_AND_DOWNLOAD')),
  download_limit integer CHECK (download_limit IS NULL OR download_limit >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,store_id,product_id),
  FOREIGN KEY (tenant_id,store_id,product_id) REFERENCES products(tenant_id,store_id,id) ON DELETE CASCADE
);

INSERT INTO product_digital_policies(tenant_id,store_id,product_id,access_mode)
SELECT p.tenant_id,p.store_id,p.id,
  CASE
    WHEN EXISTS(SELECT 1 FROM product_fulfillment_modes f WHERE f.tenant_id=p.tenant_id AND f.store_id=p.store_id AND f.product_id=p.id AND f.mode='DIGITAL_DOWNLOAD')
     AND EXISTS(SELECT 1 FROM product_fulfillment_modes f WHERE f.tenant_id=p.tenant_id AND f.store_id=p.store_id AND f.product_id=p.id AND f.mode='DIGITAL_ACCESS') THEN 'VIEW_AND_DOWNLOAD'
    WHEN EXISTS(SELECT 1 FROM product_fulfillment_modes f WHERE f.tenant_id=p.tenant_id AND f.store_id=p.store_id AND f.product_id=p.id AND f.mode='DIGITAL_DOWNLOAD') THEN 'DOWNLOAD_ONLY'
    ELSE 'VIEW_ONLY'
  END
FROM products p WHERE p.product_type IN ('DIGITAL_IMAGE','DIGITAL_VIDEO')
ON CONFLICT DO NOTHING;

CREATE TABLE order_digital_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  access_mode text NOT NULL CHECK (access_mode IN ('VIEW_ONLY','DOWNLOAD_ONLY','VIEW_AND_DOWNLOAD')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  download_limit integer CHECK (download_limit IS NULL OR download_limit >= 0),
  download_count integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  granted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,order_item_id),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,order_item_id) REFERENCES order_items(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,product_id) REFERENCES products(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX order_digital_entitlements_customer_idx ON order_digital_entitlements(tenant_id,store_id,customer_id,status,created_at DESC);

CREATE TABLE order_digital_entitlement_assets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,store_id,entitlement_id,asset_id),
  FOREIGN KEY (tenant_id,store_id,entitlement_id) REFERENCES order_digital_entitlements(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE RESTRICT
);

CREATE TABLE digital_access_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  asset_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('VIEW','DOWNLOAD')),
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,entitlement_id) REFERENCES order_digital_entitlements(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE SET NULL
);
CREATE INDEX digital_access_events_entitlement_idx ON digital_access_events(tenant_id,store_id,entitlement_id,created_at DESC);
