-- Luke Shop Backend v0.10.0 — Store Designer Engine v3
-- Additive migration. Migrations 001-010 remain immutable.

ALTER TABLE storefront_experience_versions
  ALTER COLUMN schema_version SET DEFAULT 3,
  ADD COLUMN IF NOT EXISTS base_template_key text,
  ADD COLUMN IF NOT EXISTS template_customized boolean NOT NULL DEFAULT false;

UPDATE storefront_experience_versions
   SET base_template_key = COALESCE(base_template_key, template_key),
       template_customized = CASE WHEN template_key IS NULL THEN false ELSE template_customized END
 WHERE base_template_key IS NULL OR template_key IS NULL;

-- Existing Experience Engine v2 rows remain readable. New writes normalize to schema v3.
-- Keep template_key for backward compatibility; base_template_key + template_customized
-- make the merchant-visible "Template · Customized" state explicit.

UPDATE platform_typography_presets
   SET settings = settings || CASE key
     WHEN 'MODERN_SANS' THEN '{"web_css_url":"https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap"}'::jsonb
     WHEN 'CLEAN_COMMERCE' THEN '{"web_css_url":"https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap"}'::jsonb
     WHEN 'GEOMETRIC' THEN '{"web_css_url":"https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap"}'::jsonb
     WHEN 'FRIENDLY' THEN '{"web_css_url":"https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap"}'::jsonb
     WHEN 'TECHNICAL' THEN '{"web_css_url":"https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap"}'::jsonb
     ELSE '{}'::jsonb
   END,
       updated_at = now()
 WHERE key IN ('MODERN_SANS','CLEAN_COMMERCE','GEOMETRIC','FRIENDLY','TECHNICAL');

UPDATE platform_storefront_templates
   SET config = jsonb_set(config, '{schema_version}', '3'::jsonb, true),
       updated_at = now()
 WHERE COALESCE((config->>'schema_version')::integer, 2) < 3;
