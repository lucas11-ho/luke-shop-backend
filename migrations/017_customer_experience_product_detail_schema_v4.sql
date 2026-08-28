-- Customer Experience v4 — Product Detail schema metadata alignment.
-- Historical experience rows remain immutable; only the default for future rows advances.

ALTER TABLE storefront_experience_versions
  ALTER COLUMN schema_version SET DEFAULT 4;
