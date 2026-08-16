# Technical Analysis — Backend v0.12.0

The release keeps order state semantic and separates presentation from workflow. `OUT_FOR_DELIVERY` remains backend data; the resolved Experience payload supplies a platform-approved visual mapping for Customer Web.

Location data is customer-controlled and tenant/order scoped. Saved-address coordinates are optional; checkout creates an immutable location snapshot. Live location uses explicit server sessions, customer ownership checks, expiry and terminal-state guards instead of silent/background permanent tracking.

Migration 013 is additive. Historical migrations 001–012 are unchanged.
