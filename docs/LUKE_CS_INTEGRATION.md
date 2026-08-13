# Luke CS Integration — v0.5.0

Luke CS supports two compatibility modes.

## STAFF compatibility

`STAFF` integration credentials may continue to use the v0.4 read endpoints for customer, published product, customer-bound order, payment, and delivery facts. These calls are now subject to the tenant customer-service policy introduced in migration 005.

## AI / Tool Gateway

`AI` credentials cannot use legacy customer-ID data routes. They must:

1. exchange the long-lived credential for a short-lived signed service token;
2. receive a short-lived customer support context from the authenticated Shop customer flow;
3. call `/v1/customer-service/tools/execute` with timestamp + one-time nonce;
4. pass service scope, context allowlist, tenant policy, and AI-specific policy checks.

See `docs/LUKE_CS_COMMERCE_CONNECTOR.md` for the full v0.5 protocol.

Available read scopes remain:

- `customer.read`
- `product.read`
- `orders.read`
- `order_status.read`
- `payments.read`
- `delivery.read`

No customer/order/payment/delivery write scopes are added in v0.5.0.
