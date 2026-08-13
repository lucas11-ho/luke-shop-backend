import { errors } from '../../core/errors.js';

export function isOwnerActor(auth) {
  return Boolean(auth?.roleKeys?.includes('OWNER'));
}

export async function getStaffRecord(client, tenantId, staffRef, { lock = false } = {}) {
  const result = await client.query(
    `SELECT id, public_id, email, display_name, status, last_login_at, created_at, updated_at,
            password_changed_at, disabled_at
       FROM merchant_users
      WHERE tenant_id = $1 AND public_id = $2
      ${lock ? 'FOR UPDATE' : ''}`,
    [tenantId, staffRef],
  );
  if (!result.rowCount) throw errors.notFound('MERCHANT_STAFF_NOT_FOUND', 'Merchant staff account not found');
  return result.rows[0];
}

export async function getStaffRoles(client, tenantId, merchantUserId) {
  const result = await client.query(
    `SELECT r.id AS internal_id, r.public_id AS id, r.key, r.name, r.description, r.is_system,
            COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
              FILTER (WHERE rp.permission_key IS NOT NULL), '{}'::text[]) AS permissions
       FROM merchant_user_roles ur
       JOIN merchant_roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
       LEFT JOIN merchant_role_permissions rp ON rp.role_id = r.id
      WHERE ur.tenant_id = $1 AND ur.merchant_user_id = $2
      GROUP BY r.id
      ORDER BY r.is_system DESC, r.name ASC`,
    [tenantId, merchantUserId],
  );
  return result.rows;
}

export async function getRoleRecord(client, tenantId, roleRef, { lock = false } = {}) {
  const result = await client.query(
    `SELECT r.id AS internal_id, r.public_id AS id, r.key, r.name, r.description, r.is_system,
            r.created_at, r.updated_at
       FROM merchant_roles r
      WHERE r.tenant_id = $1 AND (r.public_id = $2 OR r.key = $2)
      ${lock ? 'FOR UPDATE OF r' : ''}`,
    [tenantId, roleRef],
  );
  if (!result.rowCount) throw errors.notFound('MERCHANT_ROLE_NOT_FOUND', 'Merchant role not found');
  const permissions = await client.query(
    'SELECT permission_key FROM merchant_role_permissions WHERE role_id=$1 ORDER BY permission_key',
    [result.rows[0].internal_id],
  );
  return { ...result.rows[0], permissions: permissions.rows.map((row) => row.permission_key) };
}

export async function getRolesByRefs(client, tenantId, refs) {
  const unique = [...new Set((refs || []).map((value) => String(value || '').trim()).filter(Boolean))];
  if (!unique.length) return [];
  const result = await client.query(
    `SELECT r.id AS internal_id, r.public_id AS id, r.key, r.name, r.description, r.is_system,
            COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
              FILTER (WHERE rp.permission_key IS NOT NULL), '{}'::text[]) AS permissions
       FROM merchant_roles r
       LEFT JOIN merchant_role_permissions rp ON rp.role_id = r.id
      WHERE r.tenant_id = $1 AND r.public_id = ANY($2::text[])
      GROUP BY r.id`,
    [tenantId, unique],
  );
  if (result.rowCount !== unique.length) throw errors.badRequest('MERCHANT_ROLE_INVALID', 'One or more selected roles do not exist');
  return result.rows;
}

export function assertCanManageRoles(actorAuth, roles) {
  const owner = isOwnerActor(actorAuth);
  const actorPermissions = new Set(actorAuth?.permissions || []);
  for (const role of roles) {
    if (role.key === 'OWNER' && !owner) {
      throw errors.forbidden('OWNER_ROLE_ASSIGNMENT_FORBIDDEN', 'Only an OWNER can assign the OWNER role');
    }
    if (!owner) {
      for (const permission of role.permissions || []) {
        if (!actorPermissions.has(permission)) {
          throw errors.forbidden('ROLE_PRIVILEGE_ESCALATION_FORBIDDEN', 'Cannot assign a role containing permissions you do not possess');
        }
      }
    }
  }
}

export function assertPermissionKeysGrantable(actorAuth, permissionKeys) {
  if (isOwnerActor(actorAuth)) return;
  const actorPermissions = new Set(actorAuth?.permissions || []);
  for (const permission of permissionKeys) {
    if (!actorPermissions.has(permission)) {
      throw errors.forbidden('ROLE_PRIVILEGE_ESCALATION_FORBIDDEN', 'Cannot grant permissions you do not possess');
    }
  }
}

export async function assertTargetOwnerManageable(client, tenantId, merchantUserId, actorAuth) {
  const roles = await getStaffRoles(client, tenantId, merchantUserId);
  const owner = isOwnerActor(actorAuth);
  if (roles.some((role) => role.key === 'OWNER') && !owner) {
    throw errors.forbidden('OWNER_MANAGEMENT_FORBIDDEN', 'Only an OWNER can manage another OWNER account');
  }
  if (!owner) {
    const actorPermissions = new Set(actorAuth?.permissions || []);
    const targetPermissions = new Set(roles.flatMap((role) => role.permissions || []));
    for (const permission of targetPermissions) {
      if (!actorPermissions.has(permission)) {
        throw errors.forbidden('STAFF_PRIVILEGE_MANAGEMENT_FORBIDDEN', 'Cannot manage a staff account with permissions you do not possess');
      }
    }
  }
  return roles;
}

export async function assertLastActiveOwnerPreserved(client, tenantId, merchantUserId) {
  const target = await client.query(
    `SELECT EXISTS(
       SELECT 1
         FROM merchant_user_roles ur
         JOIN merchant_roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
        WHERE ur.tenant_id = $1 AND ur.merchant_user_id = $2 AND r.key = 'OWNER'
     ) AS is_owner,
     (SELECT status FROM merchant_users WHERE tenant_id = $1 AND id = $2) AS status`,
    [tenantId, merchantUserId],
  );
  if (!target.rows[0]?.is_owner || target.rows[0]?.status !== 'ACTIVE') return;
  const count = await client.query(
    `SELECT count(DISTINCT u.id)::int AS n
       FROM merchant_users u
       JOIN merchant_user_roles ur ON ur.tenant_id = u.tenant_id AND ur.merchant_user_id = u.id
       JOIN merchant_roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
      WHERE u.tenant_id = $1 AND u.status = 'ACTIVE' AND r.key = 'OWNER'`,
    [tenantId],
  );
  if (count.rows[0].n <= 1) {
    throw errors.conflict('LAST_ACTIVE_OWNER_REQUIRED', 'The tenant must keep at least one active OWNER');
  }
}

export async function listEffectivePermissions(client, tenantId, merchantUserId) {
  const result = await client.query(
    `SELECT DISTINCT rp.permission_key
       FROM merchant_user_roles ur
       JOIN merchant_roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
       JOIN merchant_role_permissions rp ON rp.role_id = r.id
      WHERE ur.tenant_id = $1 AND ur.merchant_user_id = $2
      ORDER BY rp.permission_key`,
    [tenantId, merchantUserId],
  );
  return result.rows.map((row) => row.permission_key);
}
