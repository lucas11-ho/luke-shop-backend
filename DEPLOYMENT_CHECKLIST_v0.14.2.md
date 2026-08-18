# Deployment Checklist — Backend v0.14.2

1. Confirm migration 016 has already been applied if R2 storage is in use. This release adds no migration 017.
2. Enable Google Cloud billing and the Geocoding API.
3. Set `GEOCODING_PROVIDER=GOOGLE`.
4. Set backend-only `GOOGLE_GEOCODING_API_KEY` and restrict it to the Geocoding API. Apply an application restriction appropriate to the production host where feasible.
5. Create a separate browser key for Customer Web and set `GOOGLE_MAPS_BROWSER_API_KEY`; restrict it by HTTP referrer to the Customer Web origin and restrict APIs to Maps JavaScript API + Places API (New).
6. Optional: set `GOOGLE_MAPS_MAP_ID` if using a Google Cloud map style/Map ID.
7. Deploy Backend v0.14.2 before Customer Web v0.9.2.
8. Sign in as a customer and verify `/v1/customer/location/map-config` reports Google enabled without exposing the server geocoding key.
9. Verify reverse geocoding from a GPS point and a map pin.
