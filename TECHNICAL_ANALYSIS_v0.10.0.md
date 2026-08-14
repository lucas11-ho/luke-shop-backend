# Technical Analysis — Backend v0.10.0

The v0.9.0 Experience Engine already provided durable draft/publish/rollback versions, signed preview tokens, platform templates, and typography presets. v0.10.0 deliberately extends that model instead of creating another design subsystem.

`normalizeExperienceConfig()` remains the canonical trust boundary. Store Designer fields are normalized on the server, layout values are allowlisted, section counts and text sizes are bounded, and arbitrary HTML/JavaScript is not accepted.

Preview security remains token-based. Merchant authentication never enters Customer Web. A signed preview token identifies the tenant, store, draft version, expiry, and creator; live unsaved editor state is a browser-only overlay and is not persisted until the Admin draft API saves it.

Quick-add capability is intentionally derived from public catalog state. Customer Web receives only enough information to decide whether a one-click add is safe; products with variants or no usable fulfillment mode fall back to the product detail flow.
