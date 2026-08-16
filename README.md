# LUKE_SHOP_BACKEND — current release v0.14.0

Luke Shop Backend is the tenant/store-scoped commerce API. v0.14.0 adds **Luke Commerce Connector v2** on top of the v0.13.0 identity/fulfillment release.

Coordinated versions:
- Backend v0.14.0 + migration 015
- Merchant Admin v0.12.0
- Customer Web v0.9.0
- Platform Admin v0.6.0 (unchanged)
- Luke CS v1.16.0 + migration 036

## v0.14.0 focus

- Enriched signed customer support contexts with customer code, locale, page path and an optional verified current-order hint.
- Order hints are accepted only after tenant + store + authenticated-customer ownership validation.
- `order.status` and `delivery.status` expose fulfillment type, semantic workflow, ETA and grouped item facts required for food, shipping, pickup and digital support answers.
- Storefront configuration can publish only safe Luke CS chat metadata (`chat_url`, `platform_route_key`, connector version). Long-lived service credentials never reach Customer Web.
- Existing CS service authentication remains short-lived-token based, timestamp/nonce replay protected, policy/scoped, tenant-bound and fully audited.
- AI remains read-only. No Shop write tool is added in this release.

See `RELEASE_NOTES_v0.14.0.md`, `TECHNICAL_ANALYSIS_v0.14.0.md`, `TEST_RESULT_v0.14.0.md` and `DEPLOYMENT_CHECKLIST_v0.14.0.md`.
