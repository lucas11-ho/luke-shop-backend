-- Luke Shop Backend v0.7.1 — Multi-tenant Storefront Routing + Domain/Preview Foundation
-- Additive migration. Migrations 001-007 remain immutable.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS slug text;

UPDATE stores
   SET slug = CASE
     WHEN is_primary THEN 'main'
     ELSE 'store-' || substr(replace(public_id, '-', ''), greatest(length(replace(public_id, '-', '')) - 9, 1), 10)
   END
 WHERE slug IS NULL;

ALTER TABLE stores
  ADD CONSTRAINT stores_slug_format_chk
  CHECK (slug IS NULL OR (slug = lower(slug) AND slug ~ '^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$'));

CREATE UNIQUE INDEX IF NOT EXISTS stores_tenant_slug_unique_idx
  ON stores(tenant_id, slug) WHERE slug IS NOT NULL;

CREATE TABLE storefront_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid REFERENCES stores(id) ON DELETE CASCADE,
  hostname text NOT NULL UNIQUE CHECK (hostname = lower(hostname)),
  status text NOT NULL CHECK (status IN ('PENDING','VERIFIED','DISABLED')) DEFAULT 'PENDING',
  verification_token_hash char(64),
  is_primary boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE INDEX storefront_domains_tenant_idx ON storefront_domains(tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX storefront_domains_primary_per_tenant_idx
  ON storefront_domains(tenant_id) WHERE is_primary = true AND status = 'VERIFIED';

CREATE TABLE storefront_preview_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  experience_version integer NOT NULL CHECK (experience_version > 0),
  created_by uuid NOT NULL REFERENCES merchant_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storefront_preview_tokens_expiry_idx ON storefront_preview_tokens(expires_at);
CREATE INDEX storefront_preview_tokens_scope_idx ON storefront_preview_tokens(tenant_id, store_id, created_at DESC);
