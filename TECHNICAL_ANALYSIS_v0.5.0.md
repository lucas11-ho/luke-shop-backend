# Luke Shop Backend v0.5.0 — Technical Analysis

## Goal

Expose Shop facts to Luke CS/AI without giving the assistant direct database access or allowing a caller-supplied customer/order identifier to become authorization.

## Authorization chain

A tool call passes all of the following:

1. active tenant-bound Luke CS integration client;
2. short-lived signed service token;
3. fresh timestamp and unused nonce;
4. valid persisted support context;
5. active customer session and active context store;
6. service scope;
7. context tool allowlist;
8. current tenant general policy;
9. current AI-specific policy for `AI` credentials;
10. tenant/customer/store query predicates.

## Signing separation

Support contexts and service tokens use different JWT audiences and, in production, different required signing secrets. This reduces cross-token blast radius and prevents one token type from validating as the other.

## Replay protection

Tool requests include timestamp and nonce. Nonces are SHA-256 hashed before persistence and unique per tenant + integration client. Duplicate use fails before tool execution.

## Database changes

Migration 005 is additive. It adds policy, context, nonce, and audit tables plus `integration_clients.usage_mode`. Existing clients remain `STAFF`. Existing tenants with an active Luke CS client are backfilled with the general read policy enabled, preserving v0.4 behavior while AI policy flags default off.

Migration 005 also adds a composite unique key to customer sessions so support-context foreign keys bind tenant + customer + session.

## Tool audit

`customer_service_tool_calls` records tool identity, target metadata, result code, request correlation ID, nonce hash, and duration. Full customer/order/payment/delivery result bodies are intentionally not copied into the audit table.

## Compatibility

STAFF clients keep v0.4 read routes, now policy-controlled. AI clients are explicitly blocked from those customer-ID routes and must use the v0.5 gateway.

Existing catalog/order/commerce lifecycle fixtures were updated to provision the new tenant CS policy after migration 005, avoiding false regressions for test-created tenants.

## Validation boundary

Dependency-free syntax/source regression suites run in the packaging environment. Fresh dependency installation timed out against the npm registry, and no live PostgreSQL service is available here, so the dependency-backed Fastify/PostgreSQL lifecycle remains a required Windows/CI gate.
