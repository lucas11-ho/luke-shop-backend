# Technical Analysis — v0.3.0

## Goal

Add a production-oriented order foundation without weakening v0.2.0 tenant isolation or allowing oversell through non-atomic stock checks.

## Core design

Checkout is a PostgreSQL transaction. Tracked inventory balance rows are locked with `FOR UPDATE` before reservation. The transaction stores immutable commercial snapshots so later catalog edits do not rewrite historical orders.

## Idempotency

Checkout uses a database uniqueness constraint on tenant + customer + idempotency key. A completed duplicate request returns the original order.

## Inventory

v0.2.0 reserved `RESERVE`, `SALE`, and `RELEASE` movement types. v0.3.0 activates them:

- checkout reserves only;
- payment-state transition to `PAID` consumes the reservation as a sale;
- allowed pre-payment cancellation/expiry releases the reservation.

## State machines

Order transitions are centralized in `src/modules/orders/service.js`. Product mix determines `PHYSICAL`, `FOOD`, `DIGITAL`, `SERVICE`, or `MIXED`. Invalid transitions return conflict rather than mutating state.

## Customer Service isolation

Luke CS order reads are tenant-bound by service credentials and additionally require a customer public ID plus an order reference. Generic tenant-wide order-number lookup is intentionally not exposed to CS.

## Expiry

Pending payment reservations have a 30-minute expiry timestamp. `npm run orders:expire` is an idempotent maintenance pass and must be scheduled externally in production.

## Known boundaries

Payment status transitions in this release are order-engine primitives, not payment-provider truth. A future payment module must own provider verification/webhooks and invoke the order transition only after verified payment events.
