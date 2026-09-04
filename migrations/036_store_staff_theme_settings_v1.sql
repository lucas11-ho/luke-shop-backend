-- Luke Shop Backend v0.15.0 — Store-scoped Staff Theme Selection v1
-- Additive only. Customer storefront theme selection remains versioned inside Store Designer experience config.

CREATE TABLE IF NOT EXISTS store_staff_theme_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  theme_key text NOT NULL,
  theme_version text NOT NULL,
  updated_by uuid REFERENCES merchant_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id),
  CONSTRAINT store_staff_theme_settings_theme_fk
    FOREIGN KEY (theme_key, theme_version)
    REFERENCES platform_theme_packages(key, version),
  CONSTRAINT store_staff_theme_settings_key_check CHECK (theme_key ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  CONSTRAINT store_staff_theme_settings_version_check CHECK (theme_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$')
);

CREATE INDEX IF NOT EXISTS store_staff_theme_settings_theme_idx
  ON store_staff_theme_settings(theme_key, theme_version);
