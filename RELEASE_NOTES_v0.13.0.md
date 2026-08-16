# Luke Shop luke-shop-backend v0.13.0

## Customer Identity, Fulfillment Intelligence & Merchant Notifications

- Adds migration 014 for readable customer codes and provider-linked login identities.
- Adds production-gated Google, Telegram and Phone OTP customer authentication plus account linking.
- Adds customer avatar upload through existing storage, reverse-geocoding boundary and formatted address persistence.
- Groups mixed orders by product type + fulfillment mode and returns server-authoritative fulfillment workflows/allowed transitions.
- Persists Merchant Admin notifications for new orders and order/fulfillment lifecycle events.
- Does not apply migration 014 automatically.

## Release boundary

- Migration 014 must be applied after a Neon backup and before v0.13.0 runtime is depended on.
- External provider credentials are required before Google/Telegram/Phone/reverse-geocoding become available.
- Runtime/database migration execution was not performed in this build environment.
