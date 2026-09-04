-- Luke Shop Backend v0.15.0 — Platform Theme Packages v1
-- Additive only. Published theme versions are immutable application-safe manifests.
-- Existing Store Designer schema v4, storefront templates and staff operations styling remain fallback authority.

CREATE TABLE IF NOT EXISTS platform_theme_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  version text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'DRAFT',
  supported_apps jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT platform_theme_packages_key_version_unique UNIQUE(key,version),
  CONSTRAINT platform_theme_packages_key_check CHECK (key ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  CONSTRAINT platform_theme_packages_version_check CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  CONSTRAINT platform_theme_packages_status_check CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  CONSTRAINT platform_theme_packages_supported_apps_check CHECK (jsonb_typeof(supported_apps)='array'),
  CONSTRAINT platform_theme_packages_manifest_check CHECK (jsonb_typeof(manifest)='object'),
  CONSTRAINT platform_theme_packages_preview_check CHECK (jsonb_typeof(preview)='object')
);

CREATE INDEX IF NOT EXISTS platform_theme_packages_catalog_idx
  ON platform_theme_packages(status,key,created_at DESC);

CREATE INDEX IF NOT EXISTS platform_theme_packages_supported_apps_gin_idx
  ON platform_theme_packages USING gin(supported_apps);
