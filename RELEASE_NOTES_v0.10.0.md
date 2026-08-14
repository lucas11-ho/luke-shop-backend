# Luke Shop Backend v0.10.0 — Store Designer Engine v3

Baseline: v0.9.0  
Migration: `011_store_designer_v3.sql`  
Experience schema: v3

## Built

- Adds truthful template provenance with `base_template_key` and `template_customized`.
- Extends Customer Experience config with SEO metadata, responsive product columns, responsive hero media position, slider slides, video/poster fields, featured-product references, and customer/internal store-name behavior.
- Adds tenant-scoped `GET /v1/merchant/stores` for the Merchant Admin store selector.
- Adds safe storefront product capability facts (`fulfillment_modes`, `has_variants`) used by Customer Web quick-add decisions.
- Adds representative public category imagery derived only from published products and public active product media.
- Carries new tenant provisioning forward to Experience schema v3.
- Adds approved web-font stylesheet metadata without bundling font binaries.

## Compatibility

Migrations 001–010 are not modified. Existing v2 Experience JSON remains readable because v3 normalization supplies defaults for new fields.

## Important deployment note

The v0.10.0 code reads columns introduced by migration 011. Apply migration 011 during the coordinated backend deployment before routing production traffic to the new process.
