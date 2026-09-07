import { PERMISSIONS } from '../../core/permissions.js';
import { resolveStore } from '../catalog/service.js';
import { getVipAnalytics } from '../loyalty/analytics.js';

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
  return{key:period,days:periodDays(period),timezone:row.timezone||'UTC',currency:row.currency||'USD',start:row.start_at?.toISOString?.()||row.start_at,end:row.end_at?.toISOString?.()||row.end_at};
}

async function orderSection(db,{tenantId,storeId,start,end,currency}){
  const [summary,recent]=await Promise.all([
    db.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE status NOT IN ('COMPLETED','CANCELLED','REFUNDED'))::int AS open,
      count(*) FILTER(WHERE status='PENDING_PAYMENT')::int AS pending_payment,
      count(*) FILTER(WHERE status IN ('PAID','CONFIRMED','RESTAURANT_ACCEPTED','PREPARING','READY','PROCESSING','PACKED','PICKED_UP','SHIPPED','OUT_FOR_DELIVERY','ACCESS_GRANTED','AVAILABLE_FOR_DOWNLOAD','DELIVERED'))::int AS processing,
      count(*) FILTER(WHERE status='COMPLETED')::int AS completed,
      count(*) FILTER(WHERE status='CANCELLED')::int AS cancelled,
      count(*) FILTER(WHERE status IN ('REFUND_PENDING','REFUNDED'))::int AS refund_related,
      COALESCE(sum(grand_total) FILTER(WHERE status='COMPLETED'),0)::numeric AS completed_sales
      FROM orders WHERE tenant_id=$1 AND store_id=$2 AND created_at >= $3 AND created_at < $4`,[tenantId,storeId,start,end]),
    db.query(`SELECT o.public_id AS id,o.order_number,c.public_id AS customer_id,c.display_name AS customer_display_name,
      o.order_type,o.status,o.payment_status,o.currency,o.grand_total,o.created_at
      FROM orders o JOIN customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
      WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.created_at >= $3 AND o.created_at < $4
      ORDER BY o.created_at DESC LIMIT 8`,[tenantId,storeId,start,end]),
  ]);
  const row=summary.rows[0]||{};
  return{summary:{total:number(row.total),open:number(row.open),pending_payment:number(row.pending_payment),processing:number(row.processing),completed:number(row.completed),cancelled:number(row.cancelled),refund_related:number(row.refund_related),completed_sales:money(row.completed_sales),currency},recent_orders:recent.rows.map(item=>({...item,grand_total:money(item.grand_total)}))};
}

async function paymentSection(db,{tenantId,storeId,start,end,currency}){
  const [payments,refunds]=await Promise.all([
    db.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE status='PAID')::int AS paid,
      count(*) FILTER(WHERE status IN ('PENDING','PROCESSING'))::int AS pending,
      count(*) FILTER(WHERE status='FAILED')::int AS failed,
      count(*) FILTER(WHERE status IN ('REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED'))::int AS refund_related,
      COALESCE(sum(GREATEST(amount-COALESCE(refunded_amount,0),0)) FILTER(WHERE status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')),0)::numeric AS net_paid_volume
      FROM order_payments WHERE tenant_id=$1 AND store_id=$2 AND created_at >= $3 AND created_at < $4`,[tenantId,storeId,start,end]),
    db.query(`SELECT count(*) FILTER(WHERE status IN ('REQUESTED','PROCESSING'))::int AS attention,
      COALESCE(sum(amount) FILTER(WHERE status='SUCCEEDED'),0)::numeric AS refunded_volume
      FROM payment_refunds WHERE tenant_id=$1 AND store_id=$2 AND requested_at >= $3 AND requested_at < $4`,[tenantId,storeId,start,end]),
  ]);
  const p=payments.rows[0]||{},r=refunds.rows[0]||{};
  return{summary:{total:number(p.total),paid:number(p.paid),pending:number(p.pending),failed:number(p.failed),refund_related:number(p.refund_related),refund_attention:number(r.attention),net_paid_volume:money(p.net_paid_volume),refunded_volume:money(r.refunded_volume),currency}};
}

async function inventorySection(db,{tenantId,storeId}){
  const result=await db.query(`WITH stock AS(
    SELECT i.id,COALESCE(sum(b.on_hand),0)::numeric AS on_hand,COALESCE(sum(b.reserved),0)::numeric AS reserved
    FROM inventory_items i LEFT JOIN inventory_balances b ON b.tenant_id=i.tenant_id AND b.store_id=i.store_id AND b.inventory_item_id=i.id
    WHERE i.tenant_id=$1 AND i.store_id=$2 AND i.status='ACTIVE' AND i.track_inventory=true GROUP BY i.id
  ) SELECT count(*)::int AS tracked_items,
    count(*) FILTER(WHERE on_hand-reserved<=5)::int AS low_stock,
    count(*) FILTER(WHERE on_hand-reserved<=0)::int AS out_of_stock,
    COALESCE(sum(on_hand),0)::numeric AS on_hand,COALESCE(sum(reserved),0)::numeric AS reserved
    FROM stock`,[tenantId,storeId]);
  const row=result.rows[0]||{};
  return{summary:{tracked_items:number(row.tracked_items),low_stock:number(row.low_stock),out_of_stock:number(row.out_of_stock),on_hand:number(row.on_hand),reserved:number(row.reserved)}};
}

async function deliverySection(db,{tenantId,storeId}){
  const [dispatch,cod]=await Promise.all([
    db.query(`SELECT count(*) FILTER(WHERE d.status NOT IN ('DELIVERED','CANCELLED'))::int AS active_dispatches,
      count(*) FILTER(WHERE d.status='ASSIGNED')::int AS awaiting_acceptance,
      count(*) FILTER(WHERE d.status='OUT_FOR_DELIVERY')::int AS out_for_delivery,
      (SELECT count(*)::int FROM order_fulfillments f WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.status='READY' AND NOT EXISTS(
        SELECT 1 FROM delivery_dispatches x WHERE x.tenant_id=f.tenant_id AND x.store_id=f.store_id AND x.fulfillment_id=f.id AND x.status NOT IN ('DELIVERED','CANCELLED'))
      ) AS ready_unassigned,
      (SELECT count(*)::int FROM delivery_drivers dr WHERE dr.tenant_id=$1 AND dr.store_id=$2 AND dr.status='ACTIVE') AS active_drivers
      FROM delivery_dispatches d WHERE d.tenant_id=$1 AND d.store_id=$2`,[tenantId,storeId]),
    db.query(`SELECT count(*) FILTER(WHERE status='COLLECTED')::int AS driver_custody_count,
      COALESCE(sum(collected_amount) FILTER(WHERE status='COLLECTED'),0)::numeric AS driver_custody_amount,
      count(*) FILTER(WHERE status='REMITTED')::int AS reconciliation_count,
      COALESCE(sum(collected_amount) FILTER(WHERE status='REMITTED'),0)::numeric AS reconciliation_amount,
      count(*) FILTER(WHERE status='RECONCILED')::int AS reconciled_count,
      max(currency) AS currency
      FROM delivery_cod_collections WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]),
  ]);
  const d=dispatch.rows[0]||{},c=cod.rows[0]||{};
  return{summary:{active_dispatches:number(d.active_dispatches),awaiting_acceptance:number(d.awaiting_acceptance),out_for_delivery:number(d.out_for_delivery),ready_unassigned:number(d.ready_unassigned),active_drivers:number(d.active_drivers),cod_driver_custody_count:number(c.driver_custody_count),cod_driver_custody_amount:money(c.driver_custody_amount),cod_reconciliation_count:number(c.reconciliation_count),cod_reconciliation_amount:money(c.reconciliation_amount),cod_reconciled_count:number(c.reconciled_count),cod_currency:c.currency||null}};
}

async function kitchenSection(db,{tenantId,storeId}){
  const result=await db.query(`SELECT count(*) FILTER(WHERE status IN ('NEW','ACCEPTED','PREPARING'))::int AS waiting,
    count(*) FILTER(WHERE status='READY')::int AS ready
    FROM kitchen_jobs WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);
  const row=result.rows[0]||{};return{summary:{waiting:number(row.waiting),ready:number(row.ready)}};
}

async function staffSection(db,{tenantId,storeId}){
  const result=await db.query(`SELECT count(DISTINCT u.id) FILTER(WHERE u.status='ACTIVE')::int AS active_staff,
    count(DISTINCT u.id) FILTER(WHERE u.status<>'ACTIVE')::int AS inactive_staff,
    count(DISTINCT u.id) FILTER(WHERE r.key='DRIVER' AND u.status='ACTIVE')::int AS drivers,
    count(DISTINCT u.id) FILTER(WHERE r.key='KITCHEN' AND u.status='ACTIVE')::int AS kitchen,
    count(DISTINCT u.id) FILTER(WHERE r.key='CASHIER' AND u.status='ACTIVE')::int AS cashiers,
    count(DISTINCT u.id) FILTER(WHERE r.key='DISPATCHER' AND u.status='ACTIVE')::int AS dispatchers
    FROM merchant_users u
    LEFT JOIN merchant_user_roles ur ON ur.tenant_id=u.tenant_id AND ur.merchant_user_id=u.id
    LEFT JOIN merchant_roles r ON r.tenant_id=ur.tenant_id AND r.id=ur.role_id
    WHERE u.tenant_id=$1 AND (u.store_access_mode='ALL_STORES' OR EXISTS(
      SELECT 1 FROM merchant_user_store_access a WHERE a.tenant_id=u.tenant_id AND a.merchant_user_id=u.id AND a.store_id=$2
    ))`,[tenantId,storeId]);
  const row=result.rows[0]||{};
  return{summary:{active_staff:number(row.active_staff),inactive_staff:number(row.inactive_staff),drivers:number(row.drivers),kitchen:number(row.kitchen),cashiers:number(row.cashiers),dispatchers:number(row.dispatchers)}};
}

async function customerSection(db,{tenantId,storeId,start,end}){
  const result=await db.query(`SELECT
    (SELECT count(*)::int FROM customers c WHERE c.tenant_id=$1 AND c.created_at >= $3 AND c.created_at < $4) AS new_customers,
    count(DISTINCT o.customer_id)::int AS ordering_customers,
    count(DISTINCT o.customer_id) FILTER(WHERE EXISTS(
      SELECT 1 FROM orders previous WHERE previous.tenant_id=o.tenant_id AND previous.customer_id=o.customer_id AND previous.created_at < $3
    ))::int AS returning_customers
    FROM orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.created_at >= $3 AND o.created_at < $4`,[tenantId,storeId,start,end]);
  const row=result.rows[0]||{};
  return{summary:{new_customers:number(row.new_customers),ordering_customers:number(row.ordering_customers),returning_customers:number(row.returning_customers)}};
}

async function catalogSection(db,{tenantId,storeId}){
  const result=await db.query(`SELECT count(*) FILTER(WHERE status='PUBLISHED')::int AS published_products,
    count(*) FILTER(WHERE status<>'PUBLISHED')::int AS unpublished_products FROM products WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);
  const row=result.rows[0]||{};return{summary:{published_products:number(row.published_products),unpublished_products:number(row.unpublished_products)}};
}

async function promotionSection(db,{tenantId,storeId}){
  const result=await db.query(`SELECT count(*) FILTER(WHERE status='ACTIVE')::int AS active_promotions,
    count(*) FILTER(WHERE status<>'ACTIVE')::int AS inactive_promotions FROM promotions WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);
  const row=result.rows[0]||{};return{summary:{active_promotions:number(row.active_promotions),inactive_promotions:number(row.inactive_promotions)}};
}

export async function merchantBusinessDashboardRoutes(app){
  app.get('/v1/merchant/business-dashboard',{
    preHandler:[app.requireMerchantAuth],
    schema:{querystring:{type:'object',additionalProperties:false,properties:{period:{type:'string',enum:['TODAY','7D','30D'],default:'TODAY'}}}},
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    const period=await resolvePeriod(app.db,request.auth.tenantId,request.query?.period||'TODAY');
    const context={store:{id:store.public_id,name:store.name,status:store.status},period};
    const available={orders:has(request,PERMISSIONS.ORDERS_READ),payments:has(request,PERMISSIONS.PAYMENTS_READ),inventory:has(request,PERMISSIONS.INVENTORY_READ),delivery:has(request,PERMISSIONS.DELIVERY_READ),kitchen:has(request,PERMISSIONS.KITCHEN_READ),staff:has(request,PERMISSIONS.MERCHANT_STAFF_READ),customers:has(request,PERMISSIONS.CUSTOMERS_READ),loyalty:has(request,PERMISSIONS.LOYALTY_READ),catalog:has(request,PERMISSIONS.CATALOG_READ),promotions:has(request,PERMISSIONS.PROMOTIONS_READ)};
    const args={tenantId:request.auth.tenantId,storeId:store.id,start:period.start,end:period.end,currency:period.currency};
    const tasks=[];const add=(key,enabled,promiseFactory)=>{if(enabled)tasks.push([key,promiseFactory()]);};
    add('orders',available.orders,()=>orderSection(app.db,args));
    add('payments',available.payments,()=>paymentSection(app.db,args));
    add('inventory',available.inventory,()=>inventorySection(app.db,args));
    add('delivery',available.delivery,()=>deliverySection(app.db,args));
    add('kitchen',available.kitchen,()=>kitchenSection(app.db,args));
    add('staff',available.staff,()=>staffSection(app.db,args));
    add('customers',available.customers,()=>customerSection(app.db,args));
    add('catalog',available.catalog,()=>catalogSection(app.db,args));
    add('promotions',available.promotions,()=>promotionSection(app.db,args));
    add('loyalty',available.loyalty,()=>getVipAnalytics(app.db,{tenantId:args.tenantId,storeId:args.storeId,days:period.days}));
    const settled=await Promise.allSettled(tasks.map(([,promise])=>promise));
    const sections={};const unavailable=[];
    settled.forEach((result,index)=>{const key=tasks[index][0];if(result.status==='fulfilled')sections[key]=result.value;else unavailable.push(key);});
    return{data:{context,available,sections,unavailable,generated_at:new Date().toISOString()}};
  });
}
