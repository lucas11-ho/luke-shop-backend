# Luke Shop Backend v0.11.1 — Customer Experience Reliability & Production Media Repair

Date: 2026-08-15
Base: v0.11.0
Database migration: none (database remains through migration 012)

## Fixed

- Explicit Fastify CORS method allowlist now includes GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS.
- Explicit browser request-header allowlist covers Authorization, Content-Type, X-Tenant-Slug and X-Store-Id.
- Request ID is exposed and preflight caching/strict validation is enabled.
- Merchant Customer Experience draft PUT is now permitted by production preflight when the Admin origin is configured in CORS_ORIGINS.
- Added Cloudflare R2 as a production media storage provider using S3-compatible SigV4 requests.
- Media upload records persist the actual storage provider instead of hardcoding LOCAL.
- Public assets can use an R2 public/custom-domain URL or the authorized Backend proxy route.
- Public media responses use Cross-Origin-Resource-Policy: cross-origin.

## Important production note

Existing media rows whose storage_provider is LOCAL still read from the local provider. If their bytes were already lost from an ephemeral Render filesystem, this release cannot recreate the missing bytes. Configure R2 and re-upload/reselect those stale assets.

## No database migration

v0.11.1 does not change the database schema. Migration 012 remains the production database baseline.
