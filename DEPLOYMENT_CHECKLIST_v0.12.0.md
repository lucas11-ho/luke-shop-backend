# Deployment Checklist — Backend v0.12.0

1. Take a Neon/PostgreSQL snapshot.
2. Confirm the deployed backend is at least v0.11.1 and migrations through 012 are present.
3. Apply `013_customer_delivery_location_status_visuals.sql` exactly once.
4. Deploy Backend v0.12.0.
5. Confirm `/health/ready` succeeds.
6. Confirm the existing CORS preflight still allows GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS for Merchant/Platform origins.
7. Verify Platform Owner can read `/v1/platform/status-visual-packs`.
8. Verify a test customer can save an address with optional GPS fields.
9. Verify checkout stores a delivery-location snapshot.
10. Verify live-location start/ping/stop only works for the owning customer and active order.
11. Deploy Customer Web v0.7.0, Merchant Admin v0.10.0 and Platform Admin v0.5.0.

Do not treat source regression tests as proof of deployed GPS/browser permission behavior. Perform browser acceptance testing after deployment.
