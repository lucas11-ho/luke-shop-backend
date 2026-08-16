# LUKE_SHOP_BACKEND — current release v0.13.0

**Customer Identity, Fulfillment Intelligence & Merchant Notifications** · 2026-08-17

Luke Shop Backend is the tenant-authoritative commerce API for Merchant Admin, Customer Web, Platform Admin and the Luke CS service connector.

Current coordinated frontend versions:
- Merchant Admin v0.11.0
- Customer Web v0.8.0
- Platform Admin v0.6.0

Database baseline: migrations through `014_customer_identity_fulfillment_notifications.sql`.

See `RELEASE_NOTES_v0.13.0.md`, `TECHNICAL_ANALYSIS_v0.13.0.md` and `DEPLOYMENT_CHECKLIST_v0.13.0.md`.



## v0.13.0 release focus

Migration 014 adds tenant-controlled readable customer codes, production-ready customer login identities, avatar/profile support, human-readable GPS address fields, type-specific fulfillment groups and merchant notification persistence. Existing UUIDs remain authoritative internal identifiers.

Coordinated versions: Backend v0.13.0, Merchant Admin v0.11.0, Customer Web v0.8.0, Platform Admin v0.6.0.

## v0.12.0 delivery intelligence

- Permissioned GPS fields are supported on saved addresses and immutable checkout/order delivery snapshots.
- Active customers can update the delivery point and explicitly start/ping/stop live-location sessions with expiry and terminal-state guards.
- Restaurant ready ETA and delivery ETA are separate fields.
- Platform-owned status visual packs provide approved icon mappings while semantic order statuses remain unchanged.

## v0.11.1 reliability repair

- Browser CORS preflight explicitly allows `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`. This repairs Merchant/Platform browser mutations such as `PUT /v1/merchant/customer-experience/draft`.
- The allowed request headers explicitly include `Authorization`, `Content-Type`, `X-Tenant-Slug` and `X-Store-Id`.
- Cloudflare R2 is supported as the production media storage driver. New production uploads no longer have to depend on Render's ephemeral local filesystem.
- Public media responses explicitly allow cross-origin resource embedding.
- Existing missing LOCAL asset bytes cannot be reconstructed automatically; stale assets must be re-uploaded/reselected after R2 is configured.

### Production CORS acceptance

An OPTIONS request for a `PUT`, `PATCH`, or `DELETE` browser call must return the requested method in `access-control-allow-methods`. A configured origin alone is not enough.

### Production media

For Render production, configure `ASSET_STORAGE_DRIVER=R2` plus the R2 credentials in `.env.example`. `LOCAL` remains supported for development/testing.

## Current control surface

v0.11.0 completes important missing management APIs for tenant stores, merchant/customer/platform self-security, saved customer addresses, inventory locations, categories/modifiers, promotion codes/targets, refund records, platform plans/typography/stores, tenant regional controls, tenant-owner controls and DNS TXT domain verification.

The backend remains the source of truth for tenant/store scope, permissions, state transitions and audit events. Frontends never receive direct database access.

## Production boundaries

- Migration 012 is additive and must be applied deliberately during production deployment.
- The Windows source installer does not execute database migrations.
- Refund controls maintain Luke's audited refund lifecycle; they do not themselves execute payment-provider money movement.
- Custom-domain verification performs a live DNS TXT lookup in the backend.
- Password reset for other merchant/platform users is an authorized administrative action. A customer self-service forgot-password email/SMS delivery flow is not fabricated without a configured external delivery provider.
- No local dev/build workflow is part of this release package.

## Verification

The shipped `npm run verify` command is a dependency-light source/regression verification suite. It does not start the application or run a frontend production build.
