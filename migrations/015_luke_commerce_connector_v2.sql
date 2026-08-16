-- Luke Shop v0.14.0 — Commerce Connector v2
-- Enrich short-lived signed customer support contexts without exposing raw contact details.

ALTER TABLE customer_service_contexts
  ADD COLUMN IF NOT EXISTS page_path text,
  ADD COLUMN IF NOT EXISTS current_order_id uuid,
  ADD COLUMN IF NOT EXISTS locale text,
  ADD COLUMN IF NOT EXISTS customer_code_snapshot text;

DO $$ BEGIN
  ALTER TABLE customer_service_contexts ADD CONSTRAINT customer_service_contexts_current_order_fk
    FOREIGN KEY (tenant_id,store_id,current_order_id)
    REFERENCES orders(tenant_id,store_id,id) ON DELETE SET NULL (current_order_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS customer_service_contexts_order_idx
  ON customer_service_contexts(tenant_id,store_id,current_order_id,expires_at DESC)
  WHERE revoked_at IS NULL AND current_order_id IS NOT NULL;
