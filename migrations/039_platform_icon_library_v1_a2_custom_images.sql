-- Luke Shop Backend v0.15.0 - Platform Icon Library v1 A2
-- Additive migration. Existing migrations remain immutable.

ALTER TABLE platform_icons DROP CONSTRAINT IF EXISTS platform_icons_source_type_check;
ALTER TABLE platform_icons ALTER COLUMN library_pack DROP NOT NULL;
ALTER TABLE platform_icons ALTER COLUMN library_icon DROP NOT NULL;
ALTER TABLE platform_icons ADD CONSTRAINT platform_icons_source_type_check CHECK (source_type IN ('LIBRARY','CUSTOM_IMAGE'));
ALTER TABLE platform_icons ADD CONSTRAINT platform_icons_source_shape_check CHECK (
  (source_type='LIBRARY' AND library_pack IS NOT NULL AND library_icon IS NOT NULL)
  OR
  (source_type='CUSTOM_IMAGE' AND library_pack IS NULL AND library_icon IS NULL AND color_mode='ORIGINAL')
);

CREATE TABLE platform_icon_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  icon_id uuid NOT NULL UNIQUE REFERENCES platform_icons(id) ON DELETE CASCADE,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 262144),
  width integer NOT NULL CHECK (width BETWEEN 16 AND 512),
  height integer NOT NULL CHECK (height BETWEEN 16 AND 512),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  body bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_icon_assets_sha256_idx ON platform_icon_assets(sha256);
