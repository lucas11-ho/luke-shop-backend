# Release Notes — Luke Shop Backend v0.4.0

**Release:** Payments, Delivery & Promotions Foundation

## Added

- migration `004_payments_delivery_promotions_foundation.sql`;
- payment methods, order payments, payment attempts, provider-event foundation;
- merchant payment confirmation/failure and customer retry;
- shipping/local-delivery/pickup methods and fulfillment tracking/history;
- percentage/fixed/free-delivery/BOGO promotions, coupon codes, targets, limits, and redemptions;
- checkout delivery/promotion/payment integration and persisted order adjustments;
- Luke CS read-only payment/delivery scopes and customer-bound endpoints;
- v0.4.0 source/core/live PostgreSQL lifecycle tests.

## Compatibility

- migrations 001, 002, and 003 are unchanged;
- existing OWNER roles receive six new permissions;
- existing stores receive safe default Manual Payment and delivery methods;
- existing v0.3 orders are backfilled into payment/fulfillment records;
- `.env`, local `docker-compose.yml`, and `package-lock.json` are not meant to be overwritten by the Windows upgrade package.

## Not included

- provider-specific verified webhooks/capture APIs;
- refunds/returns;
- tax calculation;
- carrier API integration;
- digital entitlement signing;
- AI write actions.
