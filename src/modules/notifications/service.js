import { publicId, uuid } from '../../core/identifiers.js';

export async function createMerchantNotification(client,{tenantId,storeId,type,title,message,orderId=null,customerId=null,payload={}}){
  const id=uuid(),pid=publicId('ntf');
  await client.query(`INSERT INTO merchant_notifications(id,public_id,tenant_id,store_id,notification_type,title,message,order_id,customer_id,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[id,pid,tenantId,storeId,type,title,message,orderId,customerId,JSON.stringify(payload||{})]);
  return pid;
}
