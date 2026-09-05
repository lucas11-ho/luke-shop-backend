ALTER TABLE store_staff_theme_settings
  ADD COLUMN IF NOT EXISTS component_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE store_staff_theme_settings
  DROP CONSTRAINT IF EXISTS store_staff_theme_settings_component_overrides_object;

ALTER TABLE store_staff_theme_settings
  ADD CONSTRAINT store_staff_theme_settings_component_overrides_object
  CHECK (jsonb_typeof(component_overrides) = 'object');
