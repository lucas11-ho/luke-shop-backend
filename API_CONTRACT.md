# Luke Shop Backend v0.11.0 — Current API Contract Summary

All tenant-sensitive operations are backend-authoritative. Merchant/customer requests are scoped by authenticated tenant context and optional validated store context. Platform Admin uses `/v1/platform/*` and never impersonates tenant headers. Luke CS uses its dedicated service boundary.

## Route inventory

Current backend source exposes 187 HTTP routes:
- Merchant/Admin: 101
- Platform Admin: 34
- Customer: 27
- Storefront: 9
- Luke CS service-to-service: 12
- Health: 3
- Public asset delivery: 1

The coordinated cross-repo audit checks normal Merchant, Customer and Platform route surfaces against their corresponding UI clients. Internal/service, health, public-asset and compatibility endpoints are intentionally excluded from normal UI parity requirements.

## v0.11.0 operations/control additions

### Merchant stores and audit
- `GET /v1/merchant/stores`
- `POST /v1/merchant/stores`
- `PATCH /v1/merchant/stores/:storeRef`
- `GET /v1/merchant/audit`

### Merchant self-service security
- `GET/PATCH /v1/merchant/me`
- `POST /v1/merchant/me/change-password`
- `GET /v1/merchant/me/sessions`
- `DELETE /v1/merchant/me/sessions/:sessionRef`
- `POST /v1/merchant/me/sessions/revoke-others`

### Customer self-service account
- `GET/PATCH /v1/customer/me`
- `GET/POST /v1/customer/me/addresses`
- `PATCH/DELETE /v1/customer/me/addresses/:addressRef`
- `POST /v1/customer/me/change-password`
- `GET /v1/customer/me/sessions`
- `DELETE /v1/customer/me/sessions/:sessionRef`
- `POST /v1/customer/me/sessions/revoke-others`

### Catalog, inventory and promotion completion
- category update
- inventory-location update
- modifier-group/option update and deactivate
- promotion-code update/deactivate
- promotion-target removal

### Payments and refunds
- payment method create/update includes public `provider_key`, `public_config` and `sort_order`
- `GET /v1/merchant/refunds`
- `POST /v1/merchant/orders/:orderRef/refunds`
- `PATCH /v1/merchant/refunds/:refundRef`

Refund records use a controlled internal lifecycle. A `SUCCEEDED` record means an authorized operator has recorded the corresponding provider/operator result; this route does not itself call a third-party payment API.

### Platform control completion
- plan create/update
- typography preset create/update
- tenant store list/create/update
- tenant regional settings (`currency`, `locale`, `timezone`) and internal notes
- tenant owner identity/access update
- Platform Owner self profile/password/session controls
- custom-domain DNS TXT verification using backend DNS resolution

## Existing core domains preserved

The release preserves catalog/products/variants/media, inventory ledger, cart/checkout/orders, payment attempts, delivery/fulfillment, promotions, Customer Experience v3, Media Library, Staff/RBAC, dynamic storefront resolution, signed draft preview and Luke CS service APIs.

## Security and production boundaries

- No direct frontend database access.
- Tenant and store IDs are validated server-side.
- Permission checks remain route-authoritative.
- Secrets must not be placed in public payment/delivery configuration.
- Migration 012 is applied separately from the Windows source installer.
- Customer forgot-password token delivery is not claimed without a configured external email/SMS provider.
