# Luke Shop Backend v0.6.0 — API Contract

All merchant access-management routes require a valid merchant bearer session. Every query is tenant scoped by the authenticated merchant tenant; clients never supply an arbitrary tenant ID.

## Permissions

- `merchant.staff.read`
- `merchant.staff.manage`
- `merchant.roles.read`
- `merchant.roles.manage`
- `merchant.sessions.manage`

Existing `OWNER` roles receive all five during migration 006.

## Permission catalog

`GET /v1/merchant/permissions`

## Roles

- `GET /v1/merchant/roles`
- `POST /v1/merchant/roles`
- `PATCH /v1/merchant/roles/:roleRef`
- `PUT /v1/merchant/roles/:roleRef/permissions`
- `DELETE /v1/merchant/roles/:roleRef`

System roles cannot be modified/deleted. Non-OWNER merchants cannot assign OWNER. A merchant cannot grant permissions they do not themselves possess.

## Staff

- `GET /v1/merchant/staff`
- `POST /v1/merchant/staff`
- `GET /v1/merchant/staff/:staffRef`
- `PATCH /v1/merchant/staff/:staffRef`
- `PUT /v1/merchant/staff/:staffRef/roles`
- `POST /v1/merchant/staff/:staffRef/reset-password`
- `POST /v1/merchant/staff/:staffRef/force-logout`

Staff creation requires an initial password that satisfies the existing 12-128 character policy. Password hashes are never returned.

`SUSPENDED`/`DISABLED` changes revoke all active sessions. Self suspend/disable and self role replacement are blocked to reduce accidental lockout risk.

## Sessions

- `GET /v1/merchant/staff/:staffRef/sessions`
- `DELETE /v1/merchant/staff/:staffRef/sessions/:sessionRef`

Session responses contain public session ID, user agent, request IP, lifecycle timestamps, and active/revoked state. Refresh-token hashes are never returned.

## v0.7.0 platform and customer-experience contract
Platform endpoints are under `/v1/platform/*`. Merchant Customer Experience endpoints are under `/v1/merchant/customer-experience*`. Public `/v1/storefront/config` exposes only published experience.


## Media Asset Library v0.8.0

- `POST /v1/merchant/assets/upload?filename=...&visibility=PUBLIC|PRIVATE` — raw image/video body; requires `catalog.write`.
- `GET /v1/merchant/assets` — list current store assets; requires `catalog.read`.
- `GET /v1/merchant/assets/:assetId/content` — authenticated asset delivery.
- `DELETE /v1/merchant/assets/:assetId` — soft-deactivate asset and active product attachments.
- `GET /v1/assets/public/:assetId` — public active asset delivery with byte-range support.
- `POST /v1/merchant/products/:productId/media` accepts `asset_id`.
- `PATCH /v1/merchant/products/:productId/media/:mediaId` changes attachment metadata/primary/status.
- `PUT /v1/merchant/products/:productId/media/order` reorders product media.
- `DELETE /v1/merchant/products/:productId/media/:mediaId` soft-deactivates the attachment.

## v0.10.0 Store Designer Engine v3

- `GET /v1/merchant/stores` returns the authenticated tenant's store selector options. It never accepts a tenant override.
- Customer Experience drafts normalize to `schema_version: 3` and add SEO, responsive product columns, responsive hero media position, slider slides, video media fields, and featured-product reference.
- Experience versions keep the backwards-compatible `template_key` plus `base_template_key` and `template_customized` for a truthful `Template · Customized` UI state.
- `POST /v1/merchant/customer-experience/preview-token` remains the only mechanism for private draft storefront preview.
- Public storefront category results include a representative public product image when one exists; no private media is exposed.
- Public storefront product summaries include fulfillment modes and variant presence so Customer Web can decide whether one-click quick-add is safe.
