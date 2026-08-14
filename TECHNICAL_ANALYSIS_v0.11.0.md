# Technical Analysis — Backend v0.11.0

The audit found that the backend had a strong commerce core but several management domains were read-only or only partially writable from the product surface. v0.11.0 adds bounded CRUD/state operations rather than generic data editors.

Migration 012 adds stable public IDs for customer/platform sessions, password-change timestamps, stable promotion-target IDs, a single-default-address constraint, merchant store permissions and `payment_refunds`.

Store creation reuses the existing store/experience/inventory defaults instead of introducing a second provisioning path. Platform and Merchant store management therefore share the same backend service boundary.

Session endpoints expose public identifiers and metadata only; token hashes are never returned. Password changes revoke other sessions.

Domain verification now resolves TXT records server-side and compares the stored challenge hash. The platform frontend can no longer simply mark a domain verified.

Refund records preserve previous payment/order state so FAILED/CANCELLED workflows can restore internal state. Provider execution remains outside this generic core until a concrete payment adapter implements it.
