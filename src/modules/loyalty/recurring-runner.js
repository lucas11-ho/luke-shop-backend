import { writeAudit } from '../../core/audit.js';
import { runRecurringVipEntitlements } from './issuance.js';

export async function runAllRecurringVipEntitlements(db, {
  now = new Date(),
  batchSize = 5000,
  requestId = 'vip-recurring-entitlements',
} = {}) {
  const limit = Number(batchSize);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error('VIP recurring batchSize must be an integer between 1 and 5000');
  }

  const totals = {
    stores_processed: 0,
    members_processed: 0,
    issued: 0,
    already_issued: 0,
    expired: 0,
    by_frequency: { TIER_ENTRY: 0, MONTHLY: 0, ANNUAL: 0, BIRTHDAY: 0 },
  };

  const stores = await db.query(`SELECT vp.tenant_id,vp.store_id,s.public_id AS store_public_id,s.name
    FROM vip_programs vp JOIN stores s ON s.id=vp.store_id AND s.tenant_id=vp.tenant_id
    WHERE vp.enabled=true AND vp.recurring_entitlement_issuance_enabled=true AND s.status='ACTIVE'
    ORDER BY vp.tenant_id,vp.store_id`);

  for (const row of stores.rows) {
    let afterCustomerId = null;
    let batchNumber = 0;

    while (true) {
      batchNumber += 1;
      const summary = await db.transaction(async (client) => {
        const result = await runRecurringVipEntitlements(client, {
          tenantId: row.tenant_id,
          storeId: row.store_id,
          now,
          limit,
          afterCustomerId,
        });

        if (result.issued > 0 || result.expired > 0) {
          const { last_customer_id: _lastCustomerId, has_more: _hasMore, ...auditSummary } = result;
          await writeAudit(client, {
            tenantId: row.tenant_id,
            actorType: 'SYSTEM',
            action: 'vip.recurring_entitlements.run',
            targetType: 'store',
            targetId: row.store_id,
            metadata: { store_id: row.store_public_id, batch: batchNumber, ...auditSummary },
            requestId,
          });
        }

        return result;
      });

      totals.members_processed += summary.processed_members;
      totals.issued += summary.issued;
      totals.already_issued += summary.already_issued;
      totals.expired += summary.expired;
      for (const key of Object.keys(totals.by_frequency)) {
        totals.by_frequency[key] += Number(summary.by_frequency?.[key] || 0);
      }

      if (!summary.has_more || !summary.last_customer_id) break;
      afterCustomerId = summary.last_customer_id;
    }

    totals.stores_processed += 1;
  }

  return totals;
}
