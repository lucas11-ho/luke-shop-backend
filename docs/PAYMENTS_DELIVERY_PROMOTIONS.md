# Payments, Delivery & Promotions — v0.4.0

## Payments

A checkout creates exactly one `order_payments` row for the order and an initial `payment_attempts` row. Failed payments can create a later retry attempt with an idempotency key. Confirming payment consumes the inventory reservation and moves the order to `PAID`.

`payment_events` is reserved for verified provider adapters. Provider secrets are not stored in tenant-visible payment method configuration.

## Delivery

A store can expose active delivery methods for shipping, local delivery, and pickup. Delivery fees support:

- flat fee;
- free delivery over a threshold;
- minimum order amount;
- estimated minimum/maximum minutes.

Checkout supports one physical delivery mode per order in v0.4.0. Each distinct fulfillment mode receives an `order_fulfillments` record. Merchant changes are guarded by an explicit fulfillment transition map and appended to `fulfillment_status_history`.

## Promotions

Rules can be automatic or code-driven. Supported types:

- percentage discount;
- fixed amount discount;
- free delivery;
- BOGO (`buy_quantity`, `get_quantity`).

Rules can target an order, products, or categories and can enforce scheduling, subtotal minimum, total usage limit, per-customer usage limit, first-order-only rules, and maximum discount.

Checkout resolves at most one code promotion or one best automatic promotion in v0.4.0. The applied result is persisted as both a redemption and order adjustment so historical totals do not depend on future rule edits.

## Upgrade/backfill

Migration 004 creates default Manual Payment, Store Pickup, Standard Shipping, and Local Delivery entries for existing stores. Existing v0.3 orders are backfilled into payment and fulfillment records based on their existing order/payment state. This is a compatibility backfill, not a provider reconciliation.
