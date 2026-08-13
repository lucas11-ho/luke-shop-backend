# Catalog & Inventory Guide — v0.2.0

## Product examples

### Clothing
Create a `PHYSICAL` product, then variants such as:

- Black / M — SKU `SHIRT-BLK-M`
- Black / L — SKU `SHIRT-BLK-L`
- White / M — SKU `SHIRT-WHT-M`

Variant `attributes` can hold `{ "color": "Black", "size": "M" }`.

### Restaurant
Create a `FOOD` product with `LOCAL_DELIVERY` and/or `PICKUP`. Modifier groups support choices such as size, cheese, extras, spice level, and add-ons.

### Digital
Create `DIGITAL_IMAGE` or `DIGITAL_VIDEO` with `DIGITAL_DOWNLOAD`/`DIGITAL_ACCESS`. Public preview media may use public URLs; paid/source assets should use `PRIVATE` storage references. Delivery entitlement/signed URLs are deferred to a later release.

## Inventory workflow

1. Product/variant creates an inventory item when inventory tracking or SKU is enabled.
2. Every store has a default inventory location after migration 002.
3. Merchant receives/returns/adjusts/damages stock through `/v1/merchant/inventory/adjustments`.
4. The balance is locked and checked.
5. A movement is appended to `inventory_ledger`.
6. The mutation is written to `audit_logs`.

Never update `inventory_balances` directly from a UI/client.
