# Deployment checklist v0.14.0

1. Snapshot Neon.
2. Apply migration 015.
3. Deploy Backend v0.14.0.
4. Configure Merchant Store Settings → Customer service with the HTTPS Luke CS chat URL and platform route key.
5. Create an AI usage-mode Luke CS credential and save it once into Luke CS Commerce Connector settings.
6. Runtime-test signed context issuance, service-token exchange, customer/order/payment/delivery tools, expired/revoked context rejection and cross-tenant rejection.
