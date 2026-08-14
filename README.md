# LUKE_SHOP_BACKEND — current release v0.10.0

**Store Designer Engine v3 + Experience Schema v3** · 2026-08-14

See `RELEASE_NOTES_v0.10.0.md` and `DEPLOYMENT_CHECKLIST_v0.10.0.md`.

# Luke Shop Backend v0.8.0

Multi-tenant commerce backend with a separate Platform Owner control plane and dynamic storefront routing.

## Release
`0.7.1-multi-tenant-storefront-routing`

## v0.8.0 adds
- Public storefront resolution by tenant slug and optional store slug.
- Verified custom-domain resolution and optional hosted-subdomain foundation.
- Per-tenant/store readable storefront paths such as `/t/abc-fashion` and `/t/abc-fashion/s/outlet`.
- Secure short-lived draft preview tokens; only SHA-256 token hashes are stored.
- Platform Owner custom-domain lifecycle controls.
- Dynamic CORS support for verified storefront domains.
- No public fallback to the `demo` tenant.

## Migration
Run `npm run migrate` to apply:

`008_storefront_routing_domain_preview.sql`

Migrations 001-007 are immutable. The upgrade installer copies migration 008 but does not apply it automatically.

## Local ports
- PostgreSQL: `127.0.0.1:5433` in the current Windows setup
- Backend: `http://localhost:4100`
- Platform Admin: `http://localhost:4172`
- Client Admin: `http://localhost:4173`
- Customer Web: `http://localhost:4174`

## Customer storefront examples
- Primary store: `http://localhost:4174/t/demo`
- Another tenant: `http://localhost:4174/t/abc-fashion`
- Non-primary store: `http://localhost:4174/t/abc-fashion/s/outlet`

The Customer Web root `/` is intentionally not mapped to Demo Store.

## Optional environment
```env
STOREFRONT_HOST_SUFFIX=
STOREFRONT_PREVIEW_TTL_SECONDS=600
```

`STOREFRONT_HOST_SUFFIX` can later support hosted tenant domains such as `abc-fashion.shop.example.com`. Custom domains are stored in `storefront_domains`; production DNS/SSL automation is a later deployment concern.

## Validation
```powershell
npm run verify
npm run migrate
npm run dev
```

Do not expose PostgreSQL directly to Platform Admin, Client Admin, Customer Web, or Luke CS. All tenant resolution remains backend-authoritative.


## Media Asset Library
Backend v0.8.0 adds tenant-scoped image/video assets. Local development uses `.data/assets`; production must set `ASSET_PUBLIC_BASE_URL`.
