# Luke CS Commerce Connector & AI Tool Gateway — v0.5.0

Luke Shop owns commerce facts. Luke CS owns conversation behavior. AI never receives database access.

## 1. Configure tenant policy

Merchant admins use `/v1/merchant/integrations/customer-service/policy` to enable general reads and, separately, AI reads. AI flags default off after migration 005.

## 2. Create a service credential

Create a Luke CS credential with `usage_mode` set to `STAFF` or `AI` and only the scopes required. The long-lived secret is returned once.

## 3. Exchange for short-lived service JWT

Luke CS calls `POST /v1/customer-service/auth/token` using the long-lived credential. Tool execution requires the returned signed token; the long-lived credential itself is rejected by `/tools/execute`.

## 4. Issue customer support context

An authenticated Shop customer calls `POST /v1/customer/support/context`. The context JWT binds tenant, customer, current customer session, store, and the tenant's generally permitted tools. The context is also persisted so it can be revoked immediately.

## 5. Execute approved tools

Luke CS calls `POST /v1/customer-service/tools/execute` with:

```text
Authorization: Bearer <short-lived service JWT>
x-luke-shop-context: <support context JWT>
x-luke-request-timestamp: <Unix seconds/milliseconds>
x-luke-request-nonce: <unique nonce>
```

Read-only tools:

```text
customer.get
product.search
product.get
orders.list
order.get
order.status
payment.status
delivery.status
```

Each request is checked against service scope, signed-context allowlist, current tenant policy, and AI policy for AI credentials. Reusing a nonce is rejected.

## 6. Use facts in Luke CS prompts

The gateway returns sanitized facts only. Luke CS Prompt Manager decides wording, language, tone, escalation behavior, and whether/how to present those facts to the customer.

## Legacy compatibility

`STAFF` credentials can continue using v0.4 read endpoints subject to policy. `AI` credentials must use the signed-context tool gateway for customer data.

## Maintenance

Run `npm run cs:cleanup` periodically to delete expired replay-nonce records and old support contexts.

## Future writes

No write tools are included. Cancel/refund/address/payment/delivery/customer mutations require a later confirmation and authorization architecture.
