# LUKE_SHOP_BACKEND — current release v0.14.0-R1

Luke Shop Backend is the tenant/store-scoped commerce API. v0.14.0-R1 is a production persistence hotfix on top of **Luke Commerce Connector v2**. It repairs Cloudflare R2 asset metadata persistence and compensating cleanup without changing the public API contract.

Coordinated versions:
- Backend v0.14.0-R1 + migrations 015–016
- Merchant Admin v0.12.0
- Customer Web v0.9.0
- Platform Admin v0.6.0 (unchanged)
- Luke CS v1.18.0 + migration 048

## v0.14.0-R1 focus

- Migration 016 expands `media_assets.storage_provider` from the legacy `LOCAL`-only constraint to `LOCAL | R2`.
- Merchant media and customer avatar uploads delete the newly written storage object if PostgreSQL persistence fails, reducing orphaned R2/local objects.
- Private R2 delivery remains supported through `/v1/assets/public/:assetId`; `R2_PUBLIC_BASE_URL` can remain blank.

- Enriched signed customer support contexts with customer code, locale, page path and an optional verified current-order hint.
- Order hints are accepted only after tenant + store + authenticated-customer ownership validation.
- `order.status` and `delivery.status` expose fulfillment type, semantic workflow, ETA and grouped item facts required for food, shipping, pickup and digital support answers.
- Storefront configuration can publish only safe Luke CS chat metadata (`chat_url`, `platform_route_key`, connector version). Long-lived service credentials never reach Customer Web.
- Existing CS service authentication remains short-lived-token based, timestamp/nonce replay protected, policy/scoped, tenant-bound and fully audited.
- AI remains read-only. No Shop write tool is added in this release.

See `RELEASE_NOTES_v0.14.0-R1.md`, `TECHNICAL_ANALYSIS_v0.14.0-R1.md`, `TEST_RESULT_v0.14.0-R1.md` and `DEPLOYMENT_CHECKLIST_v0.14.0-R1.md`.
