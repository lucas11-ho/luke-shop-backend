-- Luke Shop Backend — Digital order-item snapshot compatibility
-- Additive repair: migration 014 is already applied in production and remains immutable.
-- Product Nature v1 stores the exact digital subtype (DIGITAL_IMAGE / DIGITAL_VIDEO)
-- on new order items, while the historical v0.13 constraint only allowed DIGITAL.

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_product_type_snapshot_check;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_product_type_snapshot_check
  CHECK (product_type_snapshot IN (
    'PHYSICAL',
    'FOOD',
    'DIGITAL',
    'DIGITAL_IMAGE',
    'DIGITAL_VIDEO',
    'SERVICE'
  ));
