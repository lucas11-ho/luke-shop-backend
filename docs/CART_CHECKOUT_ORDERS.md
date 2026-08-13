# Cart, Checkout & Orders — v0.3.0

## Data ownership

Every cart/order row is tenant-scoped. Store-facing rows also carry `store_id`. Customer endpoints derive customer ownership from the verified access-token session.

## Cart

- one active cart per tenant/store/customer;
- cart item writes snapshot current product/variant/modifier price information;
- stock is checked again at checkout, not reserved while browsing;
- quantity updates revalidate product/variant/modifier availability and price.

## Checkout

Checkout requires an idempotency key. The transaction:

1. locks the active cart;
2. revalidates every product, variant, fulfillment mode, modifier, and price;
3. requires an address for shipping/local delivery;
4. creates checkout + order snapshots;
5. locks inventory balances;
6. reserves tracked stock;
7. appends `RESERVE` ledger movements;
8. records initial `PENDING_PAYMENT` history;
9. marks the cart `CHECKED_OUT`;
10. commits atomically.

Any failure rolls the transaction back.

## Inventory reservation lifecycle

- checkout: `reserved += quantity`, `RESERVE` ledger;
- transition to `PAID`: `on_hand -= quantity`, `reserved -= quantity`, `SALE` ledger;
- pre-payment cancel/expiry: `reserved -= quantity`, `RELEASE` ledger.

Paid-order refund/restock behavior is intentionally deferred to the payment/refund release.

## Customer cancellation

Customer cancellation is allowed only when the order state machine permits `CANCELLED` (currently pre-payment/payment-failed states). Paid/fulfilled orders must use future refund workflows rather than silently restoring inventory.

## Order state history

Every state change is appended to `order_status_history` with actor type, reason, request ID, and timestamp.

## Idempotency

`UNIQUE(tenant_id, customer_id, idempotency_key)` prevents duplicate checkout orders for a retried customer request.
