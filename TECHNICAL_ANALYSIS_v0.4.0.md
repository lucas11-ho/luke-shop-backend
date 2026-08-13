# Technical Analysis — Luke Shop Backend v0.4.0

v0.4.0 extends the v0.3.0 order foundation without rewriting earlier migrations. Payment, fulfillment, and promotion records are separate from the core order row so provider/delivery concerns can evolve while historical order totals remain stable.

## Transactional invariants

- checkout revalidates cart/catalog, resolves delivery/promotions, reserves inventory, and persists the order/payment/fulfillment/redemption records in one transaction;
- payment confirmation locks the order payment, consumes active inventory reservations, and synchronizes payment/order state;
- promotion resolution locks candidate promotion/code rows and writes a redemption record on successful checkout;
- fulfillment transitions use an explicit transition map and append history.

## Upgrade strategy

Migration 004 is additive. It grants existing OWNER roles the new permissions, creates safe store defaults, and creates compatibility payment/fulfillment rows for existing orders. It does not attempt external payment reconciliation.

## Security analysis

Payment method configuration is public-only; there are no raw card/CVV/provider-secret columns. Luke CS reads are customer+order bound and sanitized. No generic public webhook endpoint is included because provider signature verification must be adapter-specific.

## Known v0.4.0 boundaries

- one physical delivery mode per checkout;
- one applied coupon or best automatic promotion per checkout;
- one order payment record with multiple attempts;
- no refunds, taxes, provider-specific webhook adapters, carrier integrations, or digital entitlement signing yet.
