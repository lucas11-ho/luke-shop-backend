# Release Notes — Backend v0.7.1

## Multi-tenant Storefront Routing + Domain/Preview Foundation

This release removes the fixed-environment `demo` storefront assumption and adds shared-deployment tenant routing.

### Added
- Migration 008: store slugs, storefront domains, preview token storage.
- `GET /v1/storefront/resolve` for tenant/store/hostname resolution.
- `GET /v1/storefront/preview/:token` for signed draft preview.
- Client Admin preview-token issuance.
- Platform Owner domain add/verify/delete APIs.
- Tenant detail storefront path and primary-store routing metadata.
- Dynamic CORS for verified custom domains and optional hosted suffix.

### Security
- Public storefronts only render PUBLISHED customer experience versions.
- Preview links are short-lived and resolve only the current DRAFT version.
- Raw preview tokens are returned once; only SHA-256 hashes are persisted.
- Publish/rollback revokes outstanding preview tokens.
- Unknown tenant/hostname never falls back to `demo`.

### Compatibility
- Migrations 001-007 remain byte-for-byte unchanged.
- Existing header-based `/v1/storefront/config` is retained for compatibility.
