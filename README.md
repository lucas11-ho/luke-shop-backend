# LUKE_SHOP_BACKEND — current release v0.11.0

**Operations & Control Completion API** · 2026-08-14

Luke Shop Backend is the tenant-authoritative commerce API for Merchant Admin, Customer Web, Platform Admin and the Luke CS service connector.

Current coordinated frontend versions:
- Merchant Admin v0.9.0
- Customer Web v0.6.0
- Platform Admin v0.4.0

Database baseline: migrations through `012_operations_control_completion.sql`.

See `RELEASE_NOTES_v0.11.0.md`, `TECHNICAL_ANALYSIS_v0.11.0.md` and `DEPLOYMENT_CHECKLIST_v0.11.0.md`.

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
