const money=value=>Number(Number(value||0).toFixed(4));
const count=value=>Number(value||0);

function normalizeActivity(rows){
  return rows.sort((a,b)=>new Date(b.occurred_at)-new Date(a.occurred_at)).slice(0,40);
}

export async function getVipAnalytics(db,{tenantId,storeId,days=30,now=new Date()}){
  const end=new Date(now);
  const start=new Date(end.getTime()-days*86400000);
  const [currencyResult,membersResult,liabilityResult,ledgerResult,ledgerByTypeResult,entitlementResult,entitlementByStatusResult,redemptionResult,tierResult,byLevelResult,topBalancesResult,ledgerTrendResult,entitlementTrendResult,tierTrendResult,recentLedgerResult,recentEntitlementsResult,recentRedemptionsResult,recentTierResult]=await Promise.all([
    db.query(`SELECT currency FROM tenant_settings WHERE tenant_id=$1`,[tenantId]),
    db.query(`SELECT count(*) FILTER (WHERE level_id IS NOT NULL)::int AS vip_members,
      count(*) FILTER (WHERE level_id IS NULL)::int AS evaluated_without_level,
      count(*) FILTER (WHERE locked)::int AS locked_members
      FROM customer_vip_status WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]),
    db.query(`SELECT COALESCE(sum(GREATEST(balance,0)),0)::numeric AS reward_liability FROM (
      SELECT customer_id,COALESCE(sum(amount),0)::numeric AS balance
      FROM vip_reward_ledger WHERE tenant_id=$1 AND store_id=$2 GROUP BY customer_id
    ) balances`,[tenantId,storeId]),
    db.query(`SELECT COALESCE(sum(amount) FILTER (WHERE amount>0),0)::numeric AS reward_credits,
      COALESCE(abs(sum(amount) FILTER (WHERE amount<0)),0)::numeric AS reward_debits
      FROM vip_reward_ledger WHERE tenant_id=$1 AND store_id=$2 AND created_at >= $3 AND created_at < $4`,[tenantId,storeId,start,end]),
    db.query(`SELECT entry_type,count(*)::int AS entries,COALESCE(sum(amount),0)::numeric AS net_amount
      FROM vip_reward_ledger WHERE tenant_id=$1 AND store_id=$2 AND created_at >= $3 AND created_at < $4
      GROUP BY entry_type ORDER BY entry_type`,[tenantId,storeId,start,end]),
    db.query(`SELECT count(*) FILTER (WHERE issued_at >= $3 AND issued_at < $4)::int AS entitlements_issued,
      count(*) FILTER (WHERE status='AVAILABLE')::int AS entitlements_available,
      count(*) FILTER (WHERE status='REDEEMED' AND redeemed_at >= $3 AND redeemed_at < $4)::int AS entitlements_redeemed,
      count(*) FILTER (WHERE status='EXPIRED' AND updated_at >= $3 AND updated_at < $4)::int AS entitlements_expired
      FROM vip_entitlements WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId,start,end]),
    db.query(`SELECT status,count(*)::int AS entitlements FROM vip_entitlements
      WHERE tenant_id=$1 AND store_id=$2 GROUP BY status ORDER BY status`,[tenantId,storeId]),
    db.query(`SELECT COALESCE(sum(amount) FILTER (WHERE status='APPLIED' AND created_at >= $3 AND created_at < $4),0)::numeric AS cashback_redeemed,
      COALESCE(sum(amount) FILTER (WHERE status='RESTORED' AND restored_at >= $3 AND restored_at < $4),0)::numeric AS cashback_restored,
      count(*) FILTER (WHERE status='APPLIED' AND created_at >= $3 AND created_at < $4)::int AS redemptions_applied,
      count(*) FILTER (WHERE status='RESTORED' AND restored_at >= $3 AND restored_at < $4)::int AS redemptions_restored
      FROM vip_reward_redemptions WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId,start,end]),
    db.query(`SELECT count(*) FILTER (WHERE h.from_level_id IS NULL AND h.to_level_id IS NOT NULL)::int AS tier_entries,
      count(*) FILTER (WHERE fl.sort_order IS NOT NULL AND tl.sort_order IS NOT NULL AND tl.sort_order>fl.sort_order)::int AS tier_upgrades,
      count(*) FILTER (WHERE (fl.sort_order IS NOT NULL AND tl.sort_order IS NOT NULL AND tl.sort_order<fl.sort_order) OR (h.from_level_id IS NOT NULL AND h.to_level_id IS NULL))::int AS tier_downgrades
      FROM vip_tier_history h
      LEFT JOIN vip_levels fl ON fl.tenant_id=h.tenant_id AND fl.store_id=h.store_id AND fl.id=h.from_level_id
      LEFT JOIN vip_levels tl ON tl.tenant_id=h.tenant_id AND tl.store_id=h.store_id AND tl.id=h.to_level_id
      WHERE h.tenant_id=$1 AND h.store_id=$2 AND h.created_at >= $3 AND h.created_at < $4`,[tenantId,storeId,start,end]),
    db.query(`SELECT l.public_id AS level_id,l.name,l.code,l.badge_color,l.sort_order,count(cvs.id)::int AS members,
      COALESCE(sum(cvs.qualified_spend),0)::numeric AS qualified_spend,COALESCE(sum(cvs.qualified_orders),0)::bigint AS qualified_orders
      FROM vip_levels l LEFT JOIN customer_vip_status cvs ON cvs.tenant_id=l.tenant_id AND cvs.store_id=l.store_id AND cvs.level_id=l.id
      WHERE l.tenant_id=$1 AND l.store_id=$2 GROUP BY l.id,l.public_id,l.name,l.code,l.badge_color,l.sort_order
      ORDER BY l.sort_order,l.created_at,l.id`,[tenantId,storeId]),
    db.query(`WITH balances AS (
      SELECT customer_id,COALESCE(sum(amount),0)::numeric AS balance FROM vip_reward_ledger
      WHERE tenant_id=$1 AND store_id=$2 GROUP BY customer_id
    ) SELECT c.public_id AS customer_id,c.customer_code,c.display_name,b.balance
      FROM balances b JOIN customers c ON c.tenant_id=$1 AND c.id=b.customer_id
      WHERE b.balance>0 ORDER BY b.balance DESC,c.display_name NULLS LAST,c.id LIMIT 10`,[tenantId,storeId]),
    db.query(`SELECT date_trunc('day',created_at)::date AS day,
      COALESCE(sum(amount) FILTER (WHERE amount>0),0)::numeric AS reward_credits,
      COALESCE(abs(sum(amount) FILTER (WHERE amount<0)),0)::numeric AS reward_debits
      FROM vip_reward_ledger WHERE tenant_id=$1 AND store_id=$2 AND created_at >= $3 AND created_at < $4
      GROUP BY 1 ORDER BY 1`,[tenantId,storeId,start,end]),
    db.query(`SELECT date_trunc('day',issued_at)::date AS day,count(*)::int AS entitlements_issued
      FROM vip_entitlements WHERE tenant_id=$1 AND store_id=$2 AND issued_at >= $3 AND issued_at < $4
      GROUP BY 1 ORDER BY 1`,[tenantId,storeId,start,end]),
    db.query(`SELECT date_trunc('day',created_at)::date AS day,count(*)::int AS tier_movements
      FROM vip_tier_history WHERE tenant_id=$1 AND store_id=$2 AND created_at >= $3 AND created_at < $4
      GROUP BY 1 ORDER BY 1`,[tenantId,storeId,start,end]),
    db.query(`SELECT l.created_at AS occurred_at,c.public_id AS customer_id,c.customer_code,c.display_name,
      'REWARD'::text AS kind,l.entry_type AS status,l.description AS detail,l.amount,l.currency,NULL::text AS actor_type
      FROM vip_reward_ledger l JOIN customers c ON c.tenant_id=l.tenant_id AND c.id=l.customer_id
      WHERE l.tenant_id=$1 AND l.store_id=$2 ORDER BY l.created_at DESC,l.id DESC LIMIT 20`,[tenantId,storeId]),
    db.query(`SELECT e.issued_at AS occurred_at,c.public_id AS customer_id,c.customer_code,c.display_name,
      'ENTITLEMENT'::text AS kind,e.status,e.entitlement_type||' · '||b.name AS detail,NULL::numeric AS amount,NULL::text AS currency,'SYSTEM'::text AS actor_type
      FROM vip_entitlements e JOIN customers c ON c.tenant_id=e.tenant_id AND c.id=e.customer_id
      JOIN vip_benefits b ON b.tenant_id=e.tenant_id AND b.store_id=e.store_id AND b.id=e.benefit_id
      WHERE e.tenant_id=$1 AND e.store_id=$2 ORDER BY e.issued_at DESC,e.id DESC LIMIT 20`,[tenantId,storeId]),
    db.query(`SELECT r.created_at AS occurred_at,c.public_id AS customer_id,c.customer_code,c.display_name,
      'REDEMPTION'::text AS kind,r.status,'Cashback redemption'::text AS detail,r.amount,r.currency,'CUSTOMER'::text AS actor_type
      FROM vip_reward_redemptions r JOIN customers c ON c.tenant_id=r.tenant_id AND c.id=r.customer_id
      WHERE r.tenant_id=$1 AND r.store_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 20`,[tenantId,storeId]),
    db.query(`SELECT h.created_at AS occurred_at,c.public_id AS customer_id,c.customer_code,c.display_name,
      'TIER'::text AS kind,h.source AS status,
      COALESCE(fl.name,'No level')||' → '||COALESCE(tl.name,'No level')||COALESCE(' · '||NULLIF(h.reason,''),'') AS detail,
      NULL::numeric AS amount,NULL::text AS currency,h.actor_type
      FROM vip_tier_history h JOIN customers c ON c.tenant_id=h.tenant_id AND c.id=h.customer_id
      LEFT JOIN vip_levels fl ON fl.tenant_id=h.tenant_id AND fl.store_id=h.store_id AND fl.id=h.from_level_id
      LEFT JOIN vip_levels tl ON tl.tenant_id=h.tenant_id AND tl.store_id=h.store_id AND tl.id=h.to_level_id
      WHERE h.tenant_id=$1 AND h.store_id=$2 ORDER BY h.created_at DESC,h.id DESC LIMIT 20`,[tenantId,storeId]),
  ]);

  const trend=new Map();
  const ensure=day=>{const key=String(day).slice(0,10);if(!trend.has(key))trend.set(key,{day:key,reward_credits:0,reward_debits:0,entitlements_issued:0,tier_movements:0});return trend.get(key);};
  for(const row of ledgerTrendResult.rows)Object.assign(ensure(row.day),{reward_credits:money(row.reward_credits),reward_debits:money(row.reward_debits)});
  for(const row of entitlementTrendResult.rows)ensure(row.day).entitlements_issued=count(row.entitlements_issued);
  for(const row of tierTrendResult.rows)ensure(row.day).tier_movements=count(row.tier_movements);

  const members=membersResult.rows[0]||{},ledger=ledgerResult.rows[0]||{},entitlements=entitlementResult.rows[0]||{},redemptions=redemptionResult.rows[0]||{},tiers=tierResult.rows[0]||{};
  return {
    period:{days,start:start.toISOString(),end:end.toISOString()},
    currency:currencyResult.rows[0]?.currency||'USD',
    summary:{
      vip_members:count(members.vip_members),evaluated_without_level:count(members.evaluated_without_level),locked_members:count(members.locked_members),
      reward_liability:money(liabilityResult.rows[0]?.reward_liability),reward_credits:money(ledger.reward_credits),reward_debits:money(ledger.reward_debits),
      cashback_redeemed:money(redemptions.cashback_redeemed),cashback_restored:money(redemptions.cashback_restored),redemptions_applied:count(redemptions.redemptions_applied),redemptions_restored:count(redemptions.redemptions_restored),
      entitlements_issued:count(entitlements.entitlements_issued),entitlements_available:count(entitlements.entitlements_available),entitlements_redeemed:count(entitlements.entitlements_redeemed),entitlements_expired:count(entitlements.entitlements_expired),
      tier_entries:count(tiers.tier_entries),tier_upgrades:count(tiers.tier_upgrades),tier_downgrades:count(tiers.tier_downgrades),
    },
    by_level:byLevelResult.rows.map(row=>({...row,members:count(row.members),qualified_spend:money(row.qualified_spend),qualified_orders:count(row.qualified_orders)})),
    reward_by_type:ledgerByTypeResult.rows.map(row=>({...row,entries:count(row.entries),net_amount:money(row.net_amount)})),
    entitlements_by_status:entitlementByStatusResult.rows.map(row=>({...row,entitlements:count(row.entitlements)})),
    trend:[...trend.values()].sort((a,b)=>a.day.localeCompare(b.day)),
    top_reward_balances:topBalancesResult.rows.map(row=>({...row,balance:money(row.balance)})),
    recent_activity:normalizeActivity([...recentLedgerResult.rows,...recentEntitlementsResult.rows,...recentRedemptionsResult.rows,...recentTierResult.rows]).map(row=>({...row,amount:row.amount===null?null:money(row.amount)})),
  };
}
