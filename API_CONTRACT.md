# Luke Shop Backend v0.12.0 — Current API Contract Summary

All tenant-sensitive operations are backend-authoritative. Merchant/customer requests are scoped by authenticated tenant context and optional validated store context. Platform Admin uses `/v1/platform/*` and never impersonates tenant headers. Luke CS uses its dedicated service boundary.

## Route inventory

Current backend source exposes **194 HTTP routes**:
- Merchant/Admin: 101
- Platform Admin: 36
- Customer: 32
- Storefront: 9
- Luke CS service-to-service: 12
- Health: 3
- Public asset delivery: 1

Internal/service, health and public-asset endpoints are not normal UI surfaces.

## v0.12.0 delivery location

Saved addresses and checkout accept optional:
- `latitude`
- `longitude`
- `accuracy_meters`
- `location_source` (`GPS`, `MAP_PIN`, `ADDRESS`)

Customer routes:
- `PATCH /v1/customer/me/addresses/:addressRef/location`
- `PATCH /v1/customer/orders/:orderRef/delivery-location`
- `POST /v1/customer/orders/:orderRef/live-location/start`
- `POST /v1/customer/orders/:orderRef/live-location/ping`
- `POST /v1/customer/orders/:orderRef/live-location/stop`

Live sessions are customer/order scoped, expire, are rate-limited and stop on terminal workflow states. Exact location is omitted from public-safe order reads.

## v0.12.0 fulfillment ETA

Merchant fulfillment updates support separate:
- `estimated_ready_at`
- `estimated_delivery_at`

This prevents restaurant kitchen-ready estimates from being confused with delivery ETA.

## v0.12.0 platform status visuals

Platform routes:
- `GET /v1/platform/status-visual-packs`
- `PATCH /v1/platform/status-visual-packs/:packKey`

Canonical packs:
`AUTO`, `MODERN`, `FASHION_LUXURY`, `RESTAURANT_MODERN`, `ELECTRONICS_PRO`, `GROCERY_CLEAN`, `DIGITAL_CREATOR`.

The platform controls approved icon-name mappings. Templates set defaults, merchants may inherit/override, and Customer Web receives the resolved public mapping. Semantic order/fulfillment states are never replaced by theme/icon values.

## Operations/control APIs carried forward

v0.11.x store management, audit, Merchant/Platform self-security, customer profile/address/session controls, catalog/inventory completion, promotions, refunds, delivery/payment public configuration, DNS verification, Store Designer v3, R2 media, Staff/RBAC and Luke CS service APIs remain supported.

## Security and production boundaries

- No direct frontend database access.
- Tenant/store/customer/order ownership is enforced server-side.
- Permission checks remain route-authoritative.
- Customer GPS/live sharing is optional and customer-controlled.
- Public-safe APIs do not expose precise/live customer coordinates.
- Migration 013 is applied separately from the Windows source installer.
- Courier/driver GPS and map-provider integration are not claimed by this release.
