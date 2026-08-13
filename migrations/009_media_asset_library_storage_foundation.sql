-- Luke Shop v0.8.0 - Media Asset Library & Storage Foundation

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  storage_provider text NOT NULL DEFAULT 'LOCAL' CHECK (storage_provider IN ('LOCAL')),
  storage_key text NOT NULL,
  visibility text NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','PRIVATE')),
  media_type text NOT NULL CHECK (media_type IN ('IMAGE','VIDEO')),
  mime_type text NOT NULL,
  original_filename text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size > 0),
  sha256 char(64) NOT NULL,
  url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  uploaded_by uuid REFERENCES merchant_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, storage_key),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE,
  CHECK ((visibility='PUBLIC' AND url IS NOT NULL) OR (visibility='PRIVATE' AND url IS NULL))
);
CREATE INDEX media_assets_store_created_idx ON media_assets(tenant_id, store_id, status, created_at DESC);
CREATE INDEX media_assets_store_type_idx ON media_assets(tenant_id, store_id, media_type, visibility, status);
CREATE INDEX media_assets_sha_idx ON media_assets(tenant_id, store_id, sha256);

ALTER TABLE product_media ADD COLUMN asset_id uuid;
ALTER TABLE product_media ADD CONSTRAINT product_media_asset_fk
  FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;
CREATE INDEX product_media_asset_idx ON product_media(tenant_id, store_id, asset_id) WHERE asset_id IS NOT NULL;
