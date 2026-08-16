# Deployment Checklist — luke-shop-backend v0.13.0

- [ ] Review Git diff and preserve `.git`.
- [ ] Confirm coordinated source versions.
- [ ] Back up Neon before migration 014 (Backend release only).
- [ ] Apply migration 014 once, before enabling v0.13 customer identity/fulfillment features.
- [ ] Configure only the external providers you intend to enable.
- [ ] Deploy Backend v0.13.0 before the three frontends depend on new endpoints.
- [ ] Deploy Customer Web v0.8.0, Merchant Admin v0.11.0, then Platform Admin v0.6.0.
- [ ] Verify customer registration/login, avatar, address/GPS, mixed fulfillment and merchant notifications against production.
- [ ] Verify Orders and bell unread badges plus sound after a browser interaction.
- [ ] Do not enable Luke CS Commerce Connector v2 yet; it is intentionally deferred.
