# Luke Shop Backend v0.14.2 — Google Maps + Delivery Address Pro

## Added
- `GEOCODING_PROVIDER=GOOGLE` production provider.
- Dedicated backend-only Google Geocoding API key.
- Dedicated browser Google Maps JavaScript key, intentionally exposed only through authenticated customer map configuration.
- Optional Google Map ID passthrough.
- Google reverse-geocoding normalization to Luke delivery-address fields.
- `GET /v1/customer/location/map-config` for authenticated Customer Web map readiness.

## Preserved
- Nominatim reverse geocoding remains supported.
- Existing saved-address, checkout snapshot, order location and live-location data model is unchanged.
- Customer Authentication Pro v0.14.1, R2 persistence repair and Commerce Connector v2 remain intact.

## Database
No migration 017 is introduced by this release. Migration 016 remains the latest migration.
