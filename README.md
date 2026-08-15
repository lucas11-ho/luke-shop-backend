# LUKE_SHOP_BACKEND — current release v0.11.1

**Customer Experience Reliability & Production Media Repair** · 2026-08-15

Luke Shop Backend is the tenant-authoritative commerce API for Merchant Admin, Customer Web, Platform Admin and the Luke CS service connector.

Current coordinated frontend versions:
- Merchant Admin v0.9.1
- Customer Web v0.6.1
- Platform Admin v0.4.0

Database baseline: migrations through `012_operations_control_completion.sql`.

See `RELEASE_NOTES_v0.11.1.md`, `TECHNICAL_ANALYSIS_v0.11.1.md` and `DEPLOYMENT_CHECKLIST_v0.11.1.md`.


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
