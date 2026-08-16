# Technical analysis — Backend v0.14.0

## Trust boundaries

The browser authenticates only to Luke Shop. It receives a short-lived Shop-signed context and sends that context to the configured Luke CS iframe. Luke CS itself uses a merchant-issued service credential only server-to-server. That long-lived credential is exchanged for a short-lived service JWT before any commerce tool call.

Every Shop tool call still requires all of: service JWT, signed customer context, request timestamp, one-time nonce, tenant policy, service scope and signed-context tool allowlist. Context resolution also checks the active Shop customer session and store.

## Current-order hint

`order_ref` on context issuance is a hint, not a client authorization grant. Backend resolves it to an internal order only after confirming tenant/store/customer ownership. Migration 015 stores that internal order ID and the signed token stores only its public reference.

## Fulfillment-aware AI facts

`order.status` and `delivery.status` now return semantic fulfillment facts such as FOOD_DELIVERY, PHYSICAL_SHIPPING or DIGITAL_DOWNLOAD, plus workflow label/status, ETA, tracking and items. The Shop state machine remains authoritative; Luke CS never rewrites status.

## Privacy

The default AI context exposes customer public identity/code and commerce facts required for the question. It does not expose customer email/phone or precise delivery GPS to AI in v2.
