# Technical Analysis — v0.14.2

Google Maps + Delivery Address Pro separates browser map rendering from server geocoding. `GOOGLE_MAPS_BROWSER_API_KEY` is a browser credential and is expected to be restricted by HTTP referrer and API allowlist. `GOOGLE_GEOCODING_API_KEY` is backend-only and is never returned by Luke APIs.

The backend reverse-geocoding route delegates to a provider service. Google uses the HTTPS Geocoding v3 endpoint with latitude/longitude and maps Google address components into Luke's existing `formatted_address`, address lines, city, state, postal code and country code contract. Nominatim remains as a compatibility provider.

No schema change is needed because migration 013/014 already persist latitude, longitude, accuracy, source and formatted delivery address fields for saved addresses and order snapshots.
