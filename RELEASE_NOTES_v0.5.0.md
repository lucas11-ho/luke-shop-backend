# Luke Shop Backend v0.5.0 — Release Notes

## Luke CS Commerce Connector & AI Tool Gateway

v0.5.0 turns the earlier Luke CS read APIs into a dedicated, customer-bound, read-only tool gateway for staff/AI integrations.

### Added

- migration `005_cs_commerce_connector_foundation.sql`;
- explicit integration-client `usage_mode` (`STAFF` or `AI`);
- tenant CS policy with separate general and AI read controls;
- short-lived customer support contexts bound to tenant, customer session, and store;
- short-lived signed Luke CS service tokens;
- separate production signing secrets for customer contexts and service tokens;
- timestamp + one-time nonce replay protection;
- durable tool-call audit without copying response payloads;
- per-tenant/client tool limits;
- merchant policy management and AI credential mode;
- maintenance command `npm run cs:cleanup`;
- CI/live lifecycle test for the connector.

### Read-only tools

- `customer.get`
- `product.search`
- `product.get`
- `orders.list`
- `order.get`
- `order.status`
- `payment.status`
- `delivery.status`

### Security behavior

The tool gateway requires a short-lived signed service JWT. A long-lived Luke CS credential is accepted only for the token exchange (and legacy STAFF-compatible service routes); it cannot call `/v1/customer-service/tools/execute` directly.

AI credentials cannot use legacy customer-ID data routes. They must use the signed customer context gateway. Current tenant policy is rechecked on every tool call.

### Deliberately not included

- order cancellation;
- refund creation;
- address/payment/delivery mutation;
- customer mutation;
- arbitrary backend endpoint tools;
- direct SQL/database access.

Those require a future explicit-confirmation and higher-risk authorization design.
