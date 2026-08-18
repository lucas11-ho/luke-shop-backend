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

## v0.13.0 Customer identity & fulfillment contracts

Customer identity/auth:
- `GET /v1/customer/auth/options`
- `POST /v1/customer/auth/google`
- `POST /v1/customer/auth/telegram`
- `POST /v1/customer/auth/phone/request`
- `POST /v1/customer/auth/phone/verify`
- `GET /v1/customer/me/auth-identities`
- `POST /v1/customer/me/auth-identities/google`
- `POST /v1/customer/me/auth-identities/telegram`
- `POST /v1/customer/me/auth-identities/phone/verify`
- `POST /v1/customer/me/avatar?filename=...` using JPEG/PNG/WEBP raw image body
- `POST /v1/customer/location/reverse-geocode`

Merchant controls:
- `GET /v1/merchant/customer-auth/options`
- `PATCH /v1/merchant/tenant/settings` with `customer_identity`
- `GET /v1/merchant/notifications`
- `POST /v1/merchant/notifications/:notificationId/read`
- `POST /v1/merchant/notifications/read-all`

Customer UUIDs remain internal. `customer_code` is the readable tenant-scoped identifier. Fulfillment groups are bound to `fulfillment_type`, and merchant fulfillment responses expose only valid `allowed_transitions` for that type.


## Commerce Connector v2 — v0.14.0

Customer Web obtains a short-lived signed support context with `POST /v1/customer/support/context`. The optional `order_ref` is resolved server-side and must belong to the authenticated customer in the resolved store. The token may carry a customer code, page path, locale and verified current-order hint, but does not expose email, phone, password or payment secrets.

Server-to-server Luke CS access uses the existing credential exchange `POST /v1/customer-service/auth/token`, then `POST /v1/customer-service/tools/execute` with a short-lived service JWT, `X-Luke-Shop-Context`, fresh request timestamp and nonce. v0.14.0 supports the existing read-only tool policy and enriches `order.status` / `delivery.status` with fulfillment-aware facts.

Storefront customer-service configuration may expose `chat_url`, `platform_route_key` and `commerce_context_version`; no long-lived credential is ever returned by a storefront endpoint.


## v0.14.1 Customer Authentication Pro
- `GET /v1/customer/auth/options` returns public provider readiness, Google Client ID, Telegram Client ID/mode, and Turnstile site key/policy; never provider secrets.
- `GET /v1/customer/auth/telegram/nonce` returns a tenant-bound short-lived nonce for modern Telegram Login.
- `POST /v1/customer/auth/google` accepts Google `credential` and optional `turnstile_token`.
- `POST /v1/customer/auth/telegram` accepts modern `id_token` + `nonce` (legacy payload remains compatibility fallback) and optional `turnstile_token`.
- Email register/login accept `turnstile_token` when policy requires it.

## v0.14.2 Customer map configuration

`GET /v1/customer/location/map-config` — authenticated customer route returning browser-safe map readiness. When Google Maps is enabled, the response includes the referrer-restricted browser API key and optional Map ID. It never returns `GOOGLE_GEOCODING_API_KEY`.

`POST /v1/customer/location/reverse-geocode` — authenticated, rate-limited reverse geocoding using the configured provider (`GOOGLE` or `NOMINATIM`). Body: `{ "latitude": number, "longitude": number }`. Response preserves the existing Luke delivery-address shape.
