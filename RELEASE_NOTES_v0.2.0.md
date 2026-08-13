# Release Notes — Luke Shop Backend v0.2.0

**Release:** Catalog & Inventory Foundation

## Added

- migration `002_catalog_inventory_foundation.sql`;
- categories and product catalog;
- product types and independent fulfillment modes;
- variants/SKUs/barcodes/attributes;
- public/private product media references;
- restaurant modifier groups/options;
- inventory locations/items/balances/ledger;
- merchant inventory adjustments;
- Catalog/Inventory RBAC permissions;
- Storefront categories/product listing/product detail;
- Luke CS read-only `product.read` capability;
- live PostgreSQL catalog/inventory lifecycle test.

## Upgrade behavior

- migration `001` remains immutable;
- migration `002` is additive;
- existing OWNER roles receive the new permissions;
- each existing store receives a default `MAIN / Main Inventory` location;
- `.env`, local Docker port customization, and package lock are not meant to be overwritten by the repair installer.

## Not included

Cart, checkout, order processing, payment capture, delivery state machine, promotions, refunds, and digital entitlement delivery are intentionally deferred.
