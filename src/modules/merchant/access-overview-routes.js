import { PERMISSIONS } from '../../core/permissions.js';

const has=(request,permission)=>request.auth?.permissions?.includes(permission);
const OPERATIONAL_ROLE_KEYS=['DRIVER','KITCHEN','CASHIER','DISPATCHER'];

async function staffSummary(db,tenantId){
  const result=await db.query(`SELECT
    count(*)::int AS total_staff,
    count(*) FILTER(WHERE u.status='ACTIVE')::int AS active_staff,
    count(*) FILTER(WHERE u.status='SUSPENDED')::int AS suspended_staff,
    count(*) FILTER(WHERE u.status IN ('DISABLED','BLOCKED'))::int AS disabled_staff,
    count(*) FILTER(WHERE u.status='ACTIVE' AND u.last_login_at IS NULL)::int AS active_never_logged_in,
    count(*) FILTER(WHERE u.store_access_mode='ASSIGNED_STORES')::int AS assigned_store_scope_staff,
    count(*) FILTER(WHERE u.store_access_mode='ALL_STORES')::int AS all_store_scope_staff,
    count(*) FILTER(WHERE u.status='ACTIVE' AND NOT EXISTS(
      SELECT 1 FROM merchant_user_roles ur WHERE ur.tenant_id=u.tenant_id AND ur.merchant_user_id=u.id
    ))::int AS active_without_roles,
    (SELECT count(*)::int FROM merchant_sessions s
      WHERE s.tenant_id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()) AS active_sessions,
    (SELECT count(*)::int FROM merchant_sessions s
      JOIN merchant_users su ON su.tenant_id=s.tenant_id AND su.id=s.merchant_user_id
      WHERE s.tenant_id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND su.status<>'ACTIVE') AS inactive_with_active_sessions,
    (SELECT count(DISTINCT ou.id)::int FROM merchant_users ou
      JOIN merchant_user_roles our ON our.tenant_id=ou.tenant_id AND our.merchant_user_id=ou.id
      JOIN merchant_roles rr ON rr.tenant_id=our.tenant_id AND rr.id=our.role_id
      WHERE ou.tenant_id=$1 AND ou.status='ACTIVE' AND rr.key='OWNER') AS active_owners
    FROM merchant_users u WHERE u.tenant_id=$1`,[tenantId]);
  return result.rows[0]||{};
}

async function roleSummary(db,tenantId){
  const totals=await db.query(`SELECT count(*)::int AS total_roles,
    count(*) FILTER(WHERE is_system)::int AS system_roles,
    count(*) FILTER(WHERE NOT is_system)::int AS custom_roles
    FROM merchant_roles WHERE tenant_id=$1`,[tenantId]);
  const operational=await db.query(`SELECT r.public_id AS id,r.key,r.name,r.description,r.is_system,
    count(DISTINCT ur.merchant_user_id)::int AS staff_count,
    COALESCE(array_agg(DISTINCT rp.permission_key ORDER BY rp.permission_key)
      FILTER(WHERE rp.permission_key IS NOT NULL),'{}'::text[]) AS permissions
    FROM merchant_roles r
    LEFT JOIN merchant_user_roles ur ON ur.tenant_id=r.tenant_id AND ur.role_id=r.id
    LEFT JOIN merchant_role_permissions rp ON rp.role_id=r.id
    WHERE r.tenant_id=$1 AND r.key=ANY($2::text[])
    GROUP BY r.id,r.public_id,r.key,r.name,r.description,r.is_system
    ORDER BY array_position($2::text[],r.key)`,[tenantId,OPERATIONAL_ROLE_KEYS]);
  return {...(totals.rows[0]||{}),operational_roles:operational.rows};
}

async function recentAccessActivity(db,tenantId){
  const result=await db.query(`SELECT a.actor_type,a.action,a.target_type,a.created_at,
    CASE WHEN a.actor_type='MERCHANT' THEN COALESCE(mu.display_name,mu.email,'Merchant') ELSE a.actor_type END AS actor_name
    FROM audit_logs a
    LEFT JOIN merchant_users mu ON mu.tenant_id=a.tenant_id AND mu.id=a.actor_id
    WHERE a.tenant_id=$1
      AND (a.action LIKE 'merchant.staff.%' OR a.action LIKE 'merchant.role.%')
    ORDER BY a.created_at DESC,a.id DESC LIMIT 20`,[tenantId]);
  return result.rows;
}

export async function merchantAccessOverviewRoutes(app){
  app.get('/v1/merchant/access/overview',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.MERCHANT_STAFF_READ)],
  },async request=>{
    const rolesVisible=has(request,PERMISSIONS.MERCHANT_ROLES_READ);
    const auditVisible=has(request,PERMISSIONS.AUDIT_READ);
    const [staff,roles,activity]=await Promise.all([
      staffSummary(app.db,request.auth.tenantId),
      rolesVisible?roleSummary(app.db,request.auth.tenantId):Promise.resolve(null),
      auditVisible?recentAccessActivity(app.db,request.auth.tenantId):Promise.resolve(null),
    ]);
    return {data:{
      summary:{
        total_staff:Number(staff.total_staff||0),active_staff:Number(staff.active_staff||0),suspended_staff:Number(staff.suspended_staff||0),disabled_staff:Number(staff.disabled_staff||0),
        active_sessions:Number(staff.active_sessions||0),active_owners:Number(staff.active_owners||0),active_never_logged_in:Number(staff.active_never_logged_in||0),
        assigned_store_scope_staff:Number(staff.assigned_store_scope_staff||0),all_store_scope_staff:Number(staff.all_store_scope_staff||0),
      },
      attention:{active_without_roles:Number(staff.active_without_roles||0),inactive_with_active_sessions:Number(staff.inactive_with_active_sessions||0)},
      roles,
      recent_access_activity:activity,
      capabilities:{
        staff_manage:has(request,PERMISSIONS.MERCHANT_STAFF_MANAGE),roles_read:rolesVisible,roles_manage:has(request,PERMISSIONS.MERCHANT_ROLES_MANAGE),
        sessions_manage:has(request,PERMISSIONS.MERCHANT_SESSIONS_MANAGE),stores_read:has(request,PERMISSIONS.STORES_READ),audit_read:auditVisible,
        store_scope_manage:has(request,PERMISSIONS.MERCHANT_STAFF_MANAGE)&&has(request,PERMISSIONS.STORES_READ),
      },
      boundaries:{
        system_roles_protected:true,last_active_owner_required:true,store_scope_server_authoritative:true,staff_web_operational_roles:OPERATIONAL_ROLE_KEYS,
      },
      generated_at:new Date().toISOString(),
    }};
  });
}
