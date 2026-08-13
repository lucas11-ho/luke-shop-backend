# Technical Analysis — v0.2.0

## Design choice

v0.2.0 uses a modular-monolith catalog/inventory domain instead of separate restaurant/clothing/digital backends. Product type describes what is sold; fulfillment describes how it is delivered.

## Data integrity

Migration 002 uses tenant/store composite foreign keys across categories, products, variants, media, modifiers, inventory items, balances, and ledger entries. This reduces the chance that a future programming error can attach a record to another tenant/store.

## Inventory consistency

Inventory writes:

1. locate a tenant/store-bound inventory item;
2. locate an active inventory location;
3. create the zero balance if needed;
4. lock the balance `FOR UPDATE`;
5. calculate the resulting on-hand state;
6. reject negative or reserved-conflicting state;
7. update the balance;
8. append a ledger movement;
9. write an audit event;
10. commit.

## Media safety

Public media uses externally safe URLs. Private media uses storage references only. Public Storefront and Luke CS paths are filtered to public active media and never return private storage keys.

## Compatibility

No package dependency is added. v0.1.1 auth and v0.1.2 HTTP semantics remain in the same code path. Migration 001 checksum is unchanged.

## Remaining production work

- run migration 002 and catalog lifecycle against real PostgreSQL on Windows/CI;
- run dependency install/audit in an environment with registry access;
- perform query-plan/load testing with production-scale catalog sizes;
- add object-storage adapter before accepting uploads;
- add order-driven inventory reservation logic in v0.3.0.
