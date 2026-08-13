# Luke Shop Backend v0.7.0 — Platform Control Plane + Storefront Experience

## Platform control plane
- Separate platform-owner authentication and sessions.
- Platform tenant provisioning, listing, lifecycle status, plans, module/limit/capability overrides.
- Platform owner reset-password and force-logout operations.
- Platform audit log.
- Seeded Starter, Professional, and Business plans.
- Seeded Modern Commerce, Restaurant Modern, and Fashion Modern storefront templates.

## Customer Experience
- Versioned per-tenant/per-store storefront experience.
- One draft and one published version at a time.
- Merchant draft save, publish, and rollback APIs.
- Safe allowlist normalization for theme, branding, navigation, and home sections.
- Public storefront config exposes only the published experience.
- Migration 007 backfills published + draft experience for existing primary stores.

## Security
Platform access tokens use a dedicated platform audience and cannot be substituted for merchant tokens. Platform mutations are owner-only and audited. Customer-facing clients never receive draft experience data.

## Database
Adds migration `007_platform_control_plane_storefront_experience.sql`. Migrations 001–006 remain immutable.
