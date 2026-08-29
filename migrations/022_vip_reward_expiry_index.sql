-- Luke Shop Backend v0.15.0 — VIP & Loyalty v1.1 reward expiry index hardening
-- Migration 021 is immutable once applied. This follow-up widens the expiry scan index
-- so expiring positive merchant reward adjustments are indexed alongside cashback earns.

DROP INDEX IF EXISTS vip_reward_ledger_expiry_idx;
CREATE INDEX vip_reward_ledger_expiry_idx
  ON vip_reward_ledger(tenant_id, store_id, expires_at)
  WHERE (entry_type='EARN' OR (entry_type='ADMIN_ADJUSTMENT' AND amount>0))
    AND expires_at IS NOT NULL;
