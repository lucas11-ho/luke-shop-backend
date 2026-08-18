# LUKE_SHOP_BACKEND — current release v0.14.2

Luke Shop Backend v0.14.2 adds **Google Maps + Delivery Address Pro** on top of Customer Authentication Pro.

- Google is now a first-class `GEOCODING_PROVIDER` alongside NONE and NOMINATIM.
- Google server-side reverse geocoding uses a dedicated `GOOGLE_GEOCODING_API_KEY`.
- Customer Web receives a separate referrer-restricted browser map key through an authenticated map-config endpoint.
- Saved-address and checkout coordinate storage continues to use the existing v0.13 location schema; no new DB migration is required.
- Nominatim remains available as a compatibility fallback.
- Customer Authentication Pro, Commerce Connector v2 and the R2 persistence repair remain carried forward.

See `RELEASE_NOTES_v0.14.2.md`, `TECHNICAL_ANALYSIS_v0.14.2.md`, `TEST_RESULT_v0.14.2.md` and `DEPLOYMENT_CHECKLIST_v0.14.2.md`.
