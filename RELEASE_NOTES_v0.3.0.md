# Release Notes — Luke Shop Backend v0.3.0

## Release

**Cart, Checkout & Orders Foundation**

## Added

- migration 003 with carts, cart items, checkout sessions, orders, order items, address snapshots, status history, and inventory reservations;
- `orders.read` and `orders.manage` merchant permissions, automatically granted to existing OWNER roles;
- customer cart/add/update/remove APIs;
- idempotent checkout API;
- customer order list/detail/cancel APIs;
- merchant order list/detail/state-transition APIs;
- physical/food/digital/service/mixed state machines;
- inventory reservation, consumption, and release ledger behavior;
- 30-minute stale reservation expiry metadata plus `npm run orders:expire`;
- Luke CS `orders.read` and `order_status.read` read-only capabilities requiring customer + order context;
- v0.3.0 source, state-machine, and live PostgreSQL lifecycle tests.

## Preserved

- migrations 001 and 002 are unchanged;
- v0.1.1 auth lifecycle;
- v0.1.2 HTTP semantics;
- v0.2.0 catalog/inventory isolation and private-media boundaries;
- local `.env`, `docker-compose.yml`, and `package-lock.json` are not overwritten by the upgrade installer.

## Deliberately deferred

- payment provider capture/webhooks;
- refund execution/restocking policy;
- delivery-provider APIs;
- tax engine;
- promotions/coupons;
- signed digital entitlements.
