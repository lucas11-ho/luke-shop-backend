import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { resolveStore } from '../catalog/service.js';
import { writeAudit } from '../../core/audit.js';
const storeHeader=r=>r.headers['x-store-id']||null;

export async function merchantNotificationRoutes(app){
  app.get('/v1/merchant/notifications',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.ORDERS_READ)],schema:{querystring:{type:'object',additionalProperties:false,properties:{unread_only:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:100,default:30}}}}},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});const vals=[request.auth.tenantId,store.id];let where='tenant_id=$1 AND store_id=$2';if(request.query.unread_only){where+=' AND read_at IS NULL';}vals.push(request.query.limit||30);
    const rows=await app.db.query(`SELECT public_id AS id,notification_type,title,message,payload,read_at,created_at FROM merchant_notifications WHERE ${where} ORDER BY created_at DESC LIMIT $${vals.length}`,vals);
    const counts=await app.db.query(`SELECT count(*) FILTER(WHERE read_at IS NULL)::int AS unread,count(*) FILTER(WHERE read_at IS NULL AND notification_type='ORDER_CREATED')::int AS new_orders FROM merchant_notifications WHERE tenant_id=$1 AND store_id=$2`,[request.auth.tenantId,store.id]);
    return {data:{notifications:rows.rows,unread:counts.rows[0]?.unread||0,new_orders:counts.rows[0]?.new_orders||0}};
  });
  app.post('/v1/merchant/notifications/:notificationId/read',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.ORDERS_READ)]},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});const r=await app.db.query(`UPDATE merchant_notifications SET read_at=COALESCE(read_at,now()) WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 RETURNING id`,[request.auth.tenantId,store.id,request.params.notificationId]);if(!r.rowCount)throw errors.notFound('NOTIFICATION_NOT_FOUND','Notification not found');return {data:{read:true}};
  });
  app.post('/v1/merchant/notifications/read-all',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.ORDERS_READ)]},async request=>app.db.transaction(async client=>{
    const store=await resolveStore(client,request.auth.tenantId,storeHeader(request),{requireActive:false});const r=await client.query(`UPDATE merchant_notifications SET read_at=COALESCE(read_at,now()) WHERE tenant_id=$1 AND store_id=$2 AND read_at IS NULL`,[request.auth.tenantId,store.id]);await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'notifications.read_all',targetType:'store',targetId:store.id,metadata:{count:r.rowCount},requestIp:request.ip,requestId:request.id});return {data:{read:r.rowCount}};
  }));
}
