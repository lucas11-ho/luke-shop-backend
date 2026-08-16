# Luke Shop Backend v0.12.0

## Delivery Intelligence & Platform-Managed Status Visuals

Base: v0.11.1. Database migration: `013_customer_delivery_location_status_visuals.sql`.

### Customer delivery location
- Saved customer addresses can persist permissioned GPS latitude, longitude, accuracy and source.
- Checkout copies the selected delivery point into an immutable order-address snapshot.
- Active orders allow the owning customer to update the precise delivery point until the order/fulfillment reaches a terminal state.
- Explicit live-location sessions support start, rate-limited ping and stop operations, with server expiry and terminal-state shutdown.
- Exact customer/live coordinates are excluded from public-safe order reads.

### Fulfillment intelligence
- `estimated_ready_at` is separate from `estimated_delivery_at` so restaurant preparation and delivery ETA are not conflated.
- Merchant fulfillment updates accept both timestamps.
- Customer order detail includes product type for industry-specific fulfillment presentation.

### Status visual control plane
- Canonical visual packs: `AUTO`, `MODERN`, `FASHION_LUXURY`, `RESTAURANT_MODERN`, `ELECTRONICS_PRO`, `GROCERY_CLEAN`, `DIGITAL_CREATOR`.
- Platform-owned `platform_status_visual_packs` stores approved semantic-status → icon-name mappings.
- Platform Owner can edit approved icon mappings through dedicated APIs; arbitrary SVG/HTML is not accepted.
- Storefront payload resolves the effective pack and public icon mapping without changing semantic order status values.
- Templates carry a default pack and merchant Customer Experience may inherit or override it.

### Deliberately deferred
- Courier/driver GPS ingestion and live courier map.
- A draggable geographic pin until a real map projection/provider is selected.
