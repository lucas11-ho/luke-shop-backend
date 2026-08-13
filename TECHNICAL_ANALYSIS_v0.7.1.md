# Technical Analysis — Backend v0.7.1

Storefront selection is now a backend-resolved context rather than a Customer Web build-time tenant constant. Resolution accepts an explicit tenant slug/store slug, a VERIFIED custom hostname, or an optional platform-hosted subdomain suffix. The resolver returns tenant, store, published experience, channel capabilities, and the canonical storefront path.

Draft preview is deliberately separate from public resolution. Client Admin requests a random preview token; the database stores only its SHA-256 digest together with tenant/store/version/merchant/expiry. The preview resolver requires an unrevoked, unexpired token and a DRAFT version.

Custom domains are a routing/security foundation only in this release. Platform Owner may create PENDING records and mark them VERIFIED for local/manual validation. Automated DNS challenge and certificate provisioning are not included.
