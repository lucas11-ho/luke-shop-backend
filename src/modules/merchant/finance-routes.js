import { PERMISSIONS } from '../../core/permissions.js';
import { resolveStore } from '../catalog/service.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const periodDays=period=>period==='30D'?30:period==='7D'?7:1;
const lookbackDays=period=>periodDays(period)-1;
const number=value=>Number(value||0);
const money=value=>Number(Number(value||0).toFixed(4));
const has=(request,permission)=>request.auth?.permissions?.includes(permission);

async function resolvePeriod(db,tenantId,period){
  const result=await db.query(`SELECT COALESCE(NULLIF(timezone,''),'UTC') AS timezone,currency,
    ((date_trunc('day',now() AT TIME ZONE COALESCE(NULLIF(timezone,''),'UTC'))-($2::int*interval '1 day')) AT TIME ZONE COALESCE(NULLIF(timezone,''),'UTC')) AS start_at,
    ((date_trunc('day',now() AT TIME ZONE COALESCE(NULLIF(timezone,''),'UTC'))+interval '1 day') AT TIME ZONE COALESCE(NULLIF(timezone,''),'UTC')) AS end_at
    FROM tenant_settings WHERE tenant_id=$1`,[tenantId,lookbackDays(period)]);
  const row=result.rows[0]||{};
  return {key:period,days:periodDays(period),timezone:row.timezone||'UTC',currency:row.currency||'USD',start:row.start_at?.toISOString?.()||row.start_at,end:row.end_at?.toISOString?.()||row.end_at};
}

async function financeSummary(db,{tenantId,storeId,start,end,currency}){
  const [orders,payments,refunds,cod]=await Promise.all([
    db.query(`SELECT count(*) FILTER(WHERE status='COMPLETED')::int AS completed_orders,
      COALESCE(sum(grand_total) FILTER(WHERE status='COMPLETED'),0)::numeric AS completed_order_value
      FROM orders WHERE tenant_id=$1 AND store_id=$2 AND created_at >= $3 AND created_at < $4`,[tenantId,storeId,start,end]),
    db.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE status IN ('PAID','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED'))::int AS paid_or_refund_related,
      count(*) FILTER(WHERE status IN ('PENDING','PROCESSING'))::int AS pending,
      count(*) FILTER(WHERE status='FAILED')::int AS failed,
      COALESCE(sum(amount) FILTER(WHERE status IN ('PAID','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),0)::numeric AS gross_paid_volume,
      COALESCE(sum(GREATEST(amount-COALESCE(refunded_amount,0),0)) FILTER(WHERE status IN ('PAID','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),0)::numeric AS net_paid_volume,
      COALESCE(sum(amount) FILTER(WHERE status IN ('PENDING','PROCESSING')),0)::numeric AS pending_volume
      FROM order_payments WHERE tenant_id=$1 AND store_id=$2 AND created_at >= $3 AND created_at < $4`,[tenantId,storeId,start,end]),
    db.query(`SELECT
      count(*) FILTER(WHERE status IN ('REQUESTED','PROCESSING'))::int AS open_count,
      COALESCE(sum(amount) FILTER(WHERE status IN ('REQUESTED','PROCESSING')),0)::numeric AS open_amount,
      count(*) FILTER(WHERE status='SUCCEEDED' AND completed_at >= $3 AND completed_at < $4)::int AS succeeded_period_count,
      COALESCE(sum(amount) FILTER(WHERE status='SUCCEEDED' AND completed_at >= $3 AND completed_at < $4),0)::numeric AS succeeded_period_amount
      FROM payment_refunds WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId,start,end]),
    db.query(`SELECT
      count(*) FILTER(WHERE status='COLLECTED')::int AS driver_custody_count,
      COALESCE(sum(collected_amount) FILTER(WHERE status='COLLECTED'),0)::numeric AS driver_custody_amount,
      count(*) FILTER(WHERE status='REMITTED')::int AS awaiting_reconciliation_count,
      COALESCE(sum(collected_amount) FILTER(WHERE status='REMITTED'),0)::numeric AS awaiting_reconciliation_amount,
      count(*) FILTER(WHERE status='RECONCILED' AND reconciled_at >= $3 AND reconciled_at < $4)::int AS reconciled_period_count,
      COALESCE(sum(collected_amount) FILTER(WHERE status='RECONCILED' AND reconciled_at >= $3 AND reconciled_at < $4),0)::numeric AS reconciled_period_amount
      FROM delivery_cod_collections WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId,start,end]),
  ]);
  const o=orders.rows[0]||{},p=payments.rows[0]||{},r=refunds.rows[0]||{},c=cod.rows[0]||{};
  return {
    currency,
    completed_orders:number(o.completed_orders),completed_order_value:money(o.completed_order_value),
    payments_total:number(p.total),paid_or_refund_related:number(p.paid_or_refund_related),pending_payments:number(p.pending),failed_payments:number(p.failed),
    gross_paid_volume:money(p.gross_paid_volume),net_paid_volume:money(p.net_paid_volume),pending_payment_volume:money(p.pending_volume),
    open_refunds:number(r.open_count),open_refund_amount:money(r.open_amount),succeeded_refunds_period:number(r.succeeded_period_count),refunded_volume_period:money(r.succeeded_period_amount),
    cod_driver_custody_count:number(c.driver_custody_count),cod_driver_custody_amount:money(c.driver_custody_amount),
    cod_awaiting_reconciliation_count:number(c.awaiting_reconciliation_count),cod_awaiting_reconciliation_amount:money(c.awaiting_reconciliation_amount),
    cod_reconciled_period_count:number(c.reconciled_period_count),cod_reconciled_period_amount:money(c.reconciled_period_amount),
  };
}

async function paymentMethodBreakdown(db,{tenantId,storeId,start,end}){
  const rows=await db.query(`SELECT pm.public_id AS id,pm.code,pm.name,pm.provider_type,pm.provider_key,pm.status,
    count(op.id)::int AS payment_count,
    count(op.id) FILTER(WHERE op.status IN ('PAID','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED'))::int AS paid_count,
    count(op.id) FILTER(WHERE op.status IN ('PENDING','PROCESSING'))::int AS pending_count,
    count(op.id) FILTER(WHERE op.status='FAILED')::int AS failed_count,
    COALESCE(sum(op.amount) FILTER(WHERE op.status IN ('PAID','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),0)::numeric AS gross_paid_volume,
    COALESCE(sum(GREATEST(op.amount-COALESCE(op.refunded_amount,0),0)) FILTER(WHERE op.status IN ('PAID','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),0)::numeric AS net_paid_volume
    FROM payment_methods pm
    LEFT JOIN order_payments op ON op.tenant_id=pm.tenant_id AND op.store_id=pm.store_id AND op.payment_method_id=pm.id AND op.created_at >= $3 AND op.created_at < $4
    WHERE pm.tenant_id=$1 AND pm.store_id=$2
    GROUP BY pm.id,pm.public_id,pm.code,pm.name,pm.provider_type,pm.provider_key,pm.status,pm.sort_order,pm.created_at
    ORDER BY pm.sort_order,pm.created_at`,[tenantId,storeId,start,end]);
  return rows.rows.map(row=>({...row,payment_count:number(row.payment_count),paid_count:number(row.paid_count),pending_count:number(row.pending_count),failed_count:number(row.failed_count),gross_paid_volume:money(row.gross_paid_volume),net_paid_volume:money(row.net_paid_volume)}));
}

async function codAttention(db,{tenantId,storeId}){
  const rows=await db.query(`SELECT c.public_id AS id,c.status,c.currency,c.expected_amount,c.collected_amount,
    c.collection_note,c.remittance_note,c.collected_at,c.remitted_at,c.updated_at,
    d.public_id AS driver_id,d.display_name AS driver_name,
    o.public_id AS order_id,o.order_number,o.status AS order_status,o.payment_status,
    op.public_id AS payment_id,op.status AS payment_record_status,pm.name AS payment_method_name
    FROM delivery_cod_collections c
    JOIN delivery_drivers d ON d.tenant_id=c.tenant_id AND d.store_id=c.store_id AND d.id=c.driver_id
    JOIN orders o ON o.tenant_id=c.tenant_id AND o.store_id=c.store_id AND o.id=c.order_id
    JOIN order_payments op ON op.tenant_id=c.tenant_id AND op.store_id=c.store_id AND op.id=c.payment_id
    JOIN payment_methods pm ON pm.tenant_id=op.tenant_id AND pm.store_id=op.store_id AND pm.id=op.payment_method_id
    WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.status IN ('COLLECTED','REMITTED')
    ORDER BY CASE c.status WHEN 'REMITTED' THEN 0 ELSE 1 END,COALESCE(c.remitted_at,c.collected_at),c.created_at LIMIT 100`,[tenantId,storeId]);
  return rows.rows.map(row=>({...row,expected_amount:money(row.expected_amount),collected_amount:money(row.collected_amount)}));
}

async function refundAttention(db,{tenantId,storeId}){
  const rows=await db.query(`SELECT r.public_id AS id,r.status,r.amount,r.currency,r.reason,r.provider_reference,r.failure_code,r.failure_message,
    r.requested_at,r.updated_at,o.public_id AS order_id,o.order_number,c.public_id AS customer_id,c.display_name AS customer_name,
    op.public_id AS payment_id,op.status AS payment_status
    FROM payment_refunds r
    JOIN orders o ON o.tenant_id=r.tenant_id AND o.store_id=r.store_id AND o.id=r.order_id
    JOIN customers c ON c.tenant_id=o.tenant_id AND c.id=o.customer_id
    JOIN order_payments op ON op.tenant_id=r.tenant_id AND op.store_id=r.store_id AND op.id=r.payment_id
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.status IN ('REQUESTED','PROCESSING')
    ORDER BY r.requested_at,r.public_id LIMIT 100`,[tenantId,storeId]);
  return rows.rows.map(row=>({...row,amount:money(row.amount)}));
}

async function recentActivity(db,{tenantId,storeId,start,end}){
  const rows=await db.query(`SELECT * FROM (
    SELECT 'PAYMENT'::text AS kind,op.public_id AS id,o.public_id AS order_id,o.order_number,op.status,op.amount,op.currency,
      COALESCE(pm.name,pm.code,'Payment')::text AS channel,COALESCE(op.paid_at,op.failed_at,op.created_at) AS occurred_at
    FROM order_payments op JOIN orders o ON o.tenant_id=op.tenant_id AND o.store_id=op.store_id AND o.id=op.order_id
    LEFT JOIN payment_methods pm ON pm.tenant_id=op.tenant_id AND pm.store_id=op.store_id AND pm.id=op.payment_method_id
    WHERE op.tenant_id=$1 AND op.store_id=$2 AND COALESCE(op.paid_at,op.failed_at,op.created_at) >= $3 AND COALESCE(op.paid_at,op.failed_at,op.created_at) < $4
    UNION ALL
    SELECT 'REFUND'::text,r.public_id,o.public_id,o.order_number,r.status,r.amount,r.currency,'Refund'::text,COALESCE(r.completed_at,r.requested_at)
    FROM payment_refunds r JOIN orders o ON o.tenant_id=r.tenant_id AND o.store_id=r.store_id AND o.id=r.order_id
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND COALESCE(r.completed_at,r.requested_at) >= $3 AND COALESCE(r.completed_at,r.requested_at) < $4
    UNION ALL
    SELECT ('COD_'||e.event_type)::text,c.public_id,o.public_id,o.order_number,e.event_type,COALESCE(e.amount,c.collected_amount),c.currency,'Cash on delivery'::text,e.created_at
    FROM delivery_cod_events e
    JOIN delivery_cod_collections c ON c.tenant_id=e.tenant_id AND c.store_id=e.store_id AND c.id=e.collection_id
    JOIN orders o ON o.tenant_id=c.tenant_id AND o.store_id=c.store_id AND o.id=c.order_id
    WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.created_at >= $3 AND e.created_at < $4
  ) activity ORDER BY occurred_at DESC,id DESC LIMIT 40`,[tenantId,storeId,start,end]);
  return rows.rows.map(row=>({...row,amount:money(row.amount)}));
}

export async function merchantFinanceRoutes(app){
  app.get('/v1/merchant/finance/overview',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.FINANCE_READ)],
    schema:{querystring:{type:'object',additionalProperties:false,properties:{period:{type:'string',enum:['TODAY','7D','30D'],default:'TODAY'}}}},
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const period=await resolvePeriod(app.db,request.auth.tenantId,request.query?.period||'TODAY');
    const args={tenantId:request.auth.tenantId,storeId:store.id,start:period.start,end:period.end,currency:period.currency};
    const [summary,methods,cod,refunds,activity]=await Promise.all([
      financeSummary(app.db,args),paymentMethodBreakdown(app.db,args),codAttention(app.db,args),refundAttention(app.db,args),recentActivity(app.db,args),
    ]);
    return {data:{
      context:{store:{id:store.public_id,name:store.name,status:store.status},period},
      summary,payment_methods:methods,reconciliation:{cod,refunds},recent_activity:activity,
      actions:{cod_reconcile:has(request,PERMISSIONS.DELIVERY_MANAGE)&&has(request,PERMISSIONS.PAYMENTS_MANAGE),refund_manage:has(request,PERMISSIONS.PAYMENTS_MANAGE)},
      capabilities:{provider_settlement_ledger:false,provider_fee_ledger:false,manual_finance_adjustments:false,csv_export:false},
      definitions:{completed_order_value:'Completed orders created inside the selected period.',gross_paid_volume:'Original paid payment value before successful refund amounts recorded on those payments.',net_paid_volume:'Paid payment value less recorded refunded amount.',cod_driver_custody:'Collected COD cash not yet marked remitted.',cod_awaiting_reconciliation:'Remitted COD cash awaiting authorized reconciliation.'},
      generated_at:new Date().toISOString(),
    }};
  });
}
