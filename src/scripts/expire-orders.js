import { loadConfig } from '../config.js';
import { createDatabase } from '../db/pool.js';
import { writeAudit } from '../core/audit.js';
import { releaseReservations } from '../modules/orders/service.js';

const config = loadConfig();
const db = createDatabase(config);
let expired = 0;
try {
  const candidates = await db.query(
    `SELECT id,public_id,order_number,tenant_id,store_id,status
       FROM orders
      WHERE status IN ('PENDING_PAYMENT','PAYMENT_FAILED')
        AND reservation_expires_at IS NOT NULL AND reservation_expires_at <= now()
      ORDER BY reservation_expires_at ASC LIMIT 500`,
  );
  for (const candidate of candidates.rows) {
    const changed = await db.transaction(async (client) => {
      const locked = await client.query(
        `SELECT * FROM orders WHERE id=$1 AND tenant_id=$2 AND status IN ('PENDING_PAYMENT','PAYMENT_FAILED')
          AND reservation_expires_at IS NOT NULL AND reservation_expires_at <= now() FOR UPDATE`,
        [candidate.id,candidate.tenant_id],
      );
      if (!locked.rowCount) return false;
      const order = locked.rows[0];
      await releaseReservations(client,{tenantId:order.tenant_id,storeId:order.store_id,orderId:order.id,requestId:'orders-expire'});
      await client.query(`UPDATE orders SET status='CANCELLED',reservation_expires_at=NULL,cancelled_at=now(),updated_at=now() WHERE id=$1`,[order.id]);
      await client.query(`UPDATE order_payments SET status='CANCELLED',cancelled_at=now(),updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN ('PENDING','PROCESSING','FAILED')`,[order.tenant_id,order.store_id,order.id]);
      await client.query(`UPDATE order_fulfillments SET status='CANCELLED',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status NOT IN ('DELIVERED','COMPLETED','CANCELLED')`,[order.tenant_id,order.store_id,order.id]);
      await client.query(`INSERT INTO order_status_history(tenant_id,store_id,order_id,from_status,to_status,reason,actor_type,request_id) VALUES($1,$2,$3,$4,'CANCELLED','Payment reservation expired','SYSTEM','orders-expire')`,[order.tenant_id,order.store_id,order.id,order.status]);
      await writeAudit(client,{tenantId:order.tenant_id,actorType:'SYSTEM',action:'order.reservation.expire',targetType:'order',targetId:order.id,metadata:{order_number:order.order_number,from_status:order.status},requestId:'orders-expire'});
      return true;
    });
    if (changed) expired += 1;
  }
  console.log(JSON.stringify({ expired_orders: expired }, null, 2));
} finally {
  await db.close();
}
