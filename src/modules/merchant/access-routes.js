import { PERMISSIONS } from '../../core/permissions.js';
import { errors } from '../../core/errors.js';
import { normalizeEmail, publicId, uuid } from '../../core/identifiers.js';
import { assertPasswordPolicy, hashPassword } from '../../core/passwords.js';
import { writeAudit } from '../../core/audit.js';
import {
  assertCanManageRoles,
  assertLastActiveOwnerPreserved,
  assertPermissionKeysGrantable,
  assertTargetOwnerManageable,
  getRoleRecord,
  getRolesByRefs,
  getStaffRecord,
  getStaffRoles,
  isOwnerActor,
  listEffectivePermissions,
} from './access-service.js';

const statusSchema = { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'DISABLED'] };
const publicRef = { type: 'string', minLength: 6, maxLength: 80 };
const staffParams = { type: 'object', additionalProperties: false, required: ['staffRef'], properties: { staffRef: publicRef } };
const roleParams = { type: 'object', additionalProperties: false, required: ['roleRef'], properties: { roleRef: publicRef } };

function normalizeRoleKey(value) {
  const key = String(value || '').trim().toUpperCase().replace(/[-\s]+/g, '_');
  if (!/^[A-Z][A-Z0-9_]{1,47}$/.test(key)) throw errors.badRequest('MERCHANT_ROLE_KEY_INVALID', 'Role key must use 2-48 uppercase letters, numbers, or underscores');
  if (key === 'OWNER') throw errors.badRequest('SYSTEM_ROLE_KEY_RESERVED', 'OWNER is a protected system role');
  return key;
}

async function roleAssignments(client, tenantId, roleId) {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM merchant_user_roles WHERE tenant_id = $1 AND role_id = $2`,
    [tenantId, roleId],
  );
  return result.rows[0].n;
}

async function serializeStaff(client, tenantId, staff) {
  const roles = await getStaffRoles(client, tenantId, staff.id);
  const permissions = await listEffectivePermissions(client, tenantId, staff.id);
  const sessions = await client.query(
    `SELECT count(*)::int AS n
       FROM merchant_sessions
      WHERE tenant_id = $1 AND merchant_user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [tenantId, staff.id],
  );
  return {
    id: staff.public_id,
    email: staff.email,
    display_name: staff.display_name,
    status: staff.status,
    last_login_at: staff.last_login_at,
    created_at: staff.created_at,
    updated_at: staff.updated_at,
    password_changed_at: staff.password_changed_at,
    roles: roles.map(({ internal_id, ...role }) => role),
    permissions,
    active_sessions: sessions.rows[0].n,
  };
}

export async function merchantAccessRoutes(app) {
  const staffRead = app.requirePermission(PERMISSIONS.MERCHANT_STAFF_READ);
  const staffManage = app.requirePermission(PERMISSIONS.MERCHANT_STAFF_MANAGE);
  const rolesRead = app.requirePermission(PERMISSIONS.MERCHANT_ROLES_READ);
  const rolesManage = app.requirePermission(PERMISSIONS.MERCHANT_ROLES_MANAGE);
  const sessionsManage = app.requirePermission(PERMISSIONS.MERCHANT_SESSIONS_MANAGE);

  app.get('/v1/merchant/permissions', { preHandler: [app.requireMerchantAuth, rolesRead] }, async () => {
    const result = await app.db.query('SELECT key, description FROM merchant_permissions ORDER BY key');
    return { data: { permissions: result.rows } };
  });

  app.get('/v1/merchant/roles', { preHandler: [app.requireMerchantAuth, rolesRead] }, async (request) => {
    const result = await app.db.query(
      `SELECT r.id AS internal_id, r.public_id AS id, r.key, r.name, r.description, r.is_system,
              r.created_at, r.updated_at,
              COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
                FILTER (WHERE rp.permission_key IS NOT NULL), '{}'::text[]) AS permissions,
              count(DISTINCT ur.merchant_user_id)::int AS staff_count
         FROM merchant_roles r
         LEFT JOIN merchant_role_permissions rp ON rp.role_id = r.id
         LEFT JOIN merchant_user_roles ur ON ur.tenant_id = r.tenant_id AND ur.role_id = r.id
        WHERE r.tenant_id = $1
        GROUP BY r.id
        ORDER BY r.is_system DESC, r.name ASC`,
      [request.auth.tenantId],
    );
    return { data: { roles: result.rows.map(({ internal_id, ...role }) => role) } };
  });

  app.post('/v1/merchant/roles', {
    preHandler: [app.requireMerchantAuth, rolesManage],
    schema: { body: { type: 'object', additionalProperties: false, required: ['key', 'name'], properties: {
      key: { type: 'string', minLength: 2, maxLength: 48 }, name: { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: ['string', 'null'], maxLength: 500 }, permission_keys: { type: 'array', uniqueItems: true, maxItems: 100, items: { type: 'string', minLength: 2, maxLength: 120 } },
    } } },
  }, async (request, reply) => {
    const key = normalizeRoleKey(request.body.key);
    const name = request.body.name.trim();
    const permissionKeys = [...new Set(request.body.permission_keys || [])].sort();
    assertPermissionKeysGrantable(request.auth, permissionKeys);
    const role = await app.db.transaction(async (client) => {
      if (permissionKeys.length) {
        const known = await client.query('SELECT key FROM merchant_permissions WHERE key = ANY($1::text[])', [permissionKeys]);
        if (known.rowCount !== permissionKeys.length) throw errors.badRequest('MERCHANT_PERMISSION_INVALID', 'One or more permissions do not exist');
      }
      const roleId = uuid();
      const inserted = await client.query(
        `INSERT INTO merchant_roles(id, public_id, tenant_id, key, name, description, is_system)
         VALUES($1,$2,$3,$4,$5,$6,false)
         RETURNING id AS internal_id, public_id AS id, key, name, description, is_system, created_at, updated_at`,
        [roleId, publicId('mrol'), request.auth.tenantId, key, name, request.body.description?.trim() || null],
      );
      for (const permission of permissionKeys) {
        await client.query('INSERT INTO merchant_role_permissions(role_id, permission_key) VALUES($1,$2)', [roleId, permission]);
      }
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'merchant.role.create', targetType: 'merchant_role', targetId: roleId,
        metadata: { key, permissions: permissionKeys }, requestIp: request.ip, requestId: request.id });
      return { ...inserted.rows[0], permissions: permissionKeys, staff_count: 0 };
    });
    const { internal_id, ...safe } = role;
    return reply.code(201).send({ data: { role: safe } });
  });

  app.patch('/v1/merchant/roles/:roleRef', {
    preHandler: [app.requireMerchantAuth, rolesManage], schema: { params: roleParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        name: { type: 'string', minLength: 2, maxLength: 100 }, description: { type: ['string', 'null'], maxLength: 500 },
      } } },
  }, async (request) => app.db.transaction(async (client) => {
    const role = await getRoleRecord(client, request.auth.tenantId, request.params.roleRef, { lock: true });
    if (role.is_system) throw errors.forbidden('SYSTEM_ROLE_PROTECTED', 'System roles cannot be modified');
    const name = request.body.name?.trim() ?? role.name;
    const description = Object.hasOwn(request.body, 'description') ? request.body.description?.trim() || null : role.description;
    await client.query('UPDATE merchant_roles SET name=$1, description=$2, updated_at=now() WHERE tenant_id=$3 AND id=$4', [name, description, request.auth.tenantId, role.internal_id]);
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
      action: 'merchant.role.update', targetType: 'merchant_role', targetId: role.internal_id, metadata: { name }, requestIp: request.ip, requestId: request.id });
    const updated = await getRoleRecord(client, request.auth.tenantId, role.id);
    const { internal_id, ...safe } = updated;
    return { data: { role: safe } };
  }));

  app.put('/v1/merchant/roles/:roleRef/permissions', {
    preHandler: [app.requireMerchantAuth, rolesManage], schema: { params: roleParams,
      body: { type: 'object', additionalProperties: false, required: ['permission_keys'], properties: {
        permission_keys: { type: 'array', uniqueItems: true, maxItems: 100, items: { type: 'string', minLength: 2, maxLength: 120 } },
      } } },
  }, async (request) => app.db.transaction(async (client) => {
    const role = await getRoleRecord(client, request.auth.tenantId, request.params.roleRef, { lock: true });
    if (role.is_system) throw errors.forbidden('SYSTEM_ROLE_PROTECTED', 'System role permissions cannot be modified');
    const permissionKeys = [...new Set(request.body.permission_keys)].sort();
    assertPermissionKeysGrantable(request.auth, permissionKeys);
    if (permissionKeys.length) {
      const known = await client.query('SELECT key FROM merchant_permissions WHERE key = ANY($1::text[])', [permissionKeys]);
      if (known.rowCount !== permissionKeys.length) throw errors.badRequest('MERCHANT_PERMISSION_INVALID', 'One or more permissions do not exist');
    }
    await client.query('DELETE FROM merchant_role_permissions WHERE role_id=$1', [role.internal_id]);
    for (const permission of permissionKeys) await client.query('INSERT INTO merchant_role_permissions(role_id, permission_key) VALUES($1,$2)', [role.internal_id, permission]);
    await client.query('UPDATE merchant_roles SET updated_at=now() WHERE tenant_id=$1 AND id=$2', [request.auth.tenantId, role.internal_id]);
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
      action: 'merchant.role.permissions.update', targetType: 'merchant_role', targetId: role.internal_id,
      metadata: { permissions: permissionKeys }, requestIp: request.ip, requestId: request.id });
    return { data: { role: { id: role.id, key: role.key, name: role.name, description: role.description, is_system: role.is_system, permissions: permissionKeys } } };
  }));

  app.delete('/v1/merchant/roles/:roleRef', { preHandler: [app.requireMerchantAuth, rolesManage], schema: { params: roleParams } }, async (request) => app.db.transaction(async (client) => {
    const role = await getRoleRecord(client, request.auth.tenantId, request.params.roleRef, { lock: true });
    if (role.is_system) throw errors.forbidden('SYSTEM_ROLE_PROTECTED', 'System roles cannot be deleted');
    const assigned = await roleAssignments(client, request.auth.tenantId, role.internal_id);
    if (assigned) throw errors.conflict('MERCHANT_ROLE_IN_USE', 'Remove this role from all staff before deleting it');
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
      action: 'merchant.role.delete', targetType: 'merchant_role', targetId: role.internal_id,
      metadata: { key: role.key }, requestIp: request.ip, requestId: request.id });
    await client.query('DELETE FROM merchant_roles WHERE tenant_id=$1 AND id=$2', [request.auth.tenantId, role.internal_id]);
    return { data: { deleted: true } };
  }));

  app.get('/v1/merchant/staff', {
    preHandler: [app.requireMerchantAuth, staffRead],
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      q: { type: 'string', maxLength: 120 }, status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'DISABLED', 'BLOCKED'] }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    } } },
  }, async (request) => {
    const q = request.query.q?.trim() || '';
    const status = request.query.status || null;
    const result = await app.db.query(
      `SELECT u.public_id AS id, u.email, u.display_name, u.status, u.last_login_at, u.created_at, u.updated_at,
              COALESCE(array_agg(DISTINCT r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}'::text[]) AS roles,
              count(DISTINCT s.id) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at > now())::int AS active_sessions
         FROM merchant_users u
         LEFT JOIN merchant_user_roles ur ON ur.tenant_id=u.tenant_id AND ur.merchant_user_id=u.id
         LEFT JOIN merchant_roles r ON r.id=ur.role_id AND r.tenant_id=ur.tenant_id
         LEFT JOIN merchant_sessions s ON s.tenant_id=u.tenant_id AND s.merchant_user_id=u.id
        WHERE u.tenant_id=$1
          AND ($2::text='' OR u.email ILIKE '%'||$2||'%' OR u.display_name ILIKE '%'||$2||'%')
          AND ($3::text IS NULL OR u.status=$3)
        GROUP BY u.id
        ORDER BY (u.public_id=$4) DESC, u.created_at ASC
        LIMIT $5`,
      [request.auth.tenantId, q, status, request.auth.profile.public_id, request.query.limit || 100],
    );
    return { data: { staff: result.rows } };
  });

  app.post('/v1/merchant/staff', {
    preHandler: [app.requireMerchantAuth, staffManage],
    schema: { body: { type: 'object', additionalProperties: false, required: ['email', 'password', 'display_name', 'role_ids'], properties: {
      email: { type: 'string', minLength: 5, maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
      password: { type: 'string', minLength: 12, maxLength: 128 }, display_name: { type: 'string', minLength: 2, maxLength: 100 },
      role_ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: publicRef },
    } } },
  }, async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    const password = assertPasswordPolicy(request.body.password);
    const created = await app.db.transaction(async (client) => {
      const roles = await getRolesByRefs(client, request.auth.tenantId, request.body.role_ids);
      assertCanManageRoles(request.auth, roles);
      const passwordHash = await hashPassword(password);
      const id = uuid();
      const inserted = await client.query(
        `INSERT INTO merchant_users(id, public_id, tenant_id, email, password_hash, display_name, status, password_changed_at)
         VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',now())
         RETURNING *`,
        [id, publicId('musr'), request.auth.tenantId, email, passwordHash, request.body.display_name.trim()],
      );
      for (const role of roles) await client.query('INSERT INTO merchant_user_roles(tenant_id, merchant_user_id, role_id) VALUES($1,$2,$3)', [request.auth.tenantId, id, role.internal_id]);
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'merchant.staff.create', targetType: 'merchant_user', targetId: id,
        metadata: { roles: roles.map((role) => role.key) }, requestIp: request.ip, requestId: request.id });
      return serializeStaff(client, request.auth.tenantId, inserted.rows[0]);
    });
    return reply.code(201).send({ data: { staff: created } });
  });

  app.get('/v1/merchant/staff/:staffRef', { preHandler: [app.requireMerchantAuth, staffRead], schema: { params: staffParams } }, async (request) => {
    const staff = await getStaffRecord(app.db.pool, request.auth.tenantId, request.params.staffRef);
    return { data: { staff: await serializeStaff(app.db.pool, request.auth.tenantId, staff) } };
  });

  app.patch('/v1/merchant/staff/:staffRef', {
    preHandler: [app.requireMerchantAuth, staffManage], schema: { params: staffParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        display_name: { type: 'string', minLength: 2, maxLength: 100 }, status: statusSchema,
      } } },
  }, async (request) => app.db.transaction(async (client) => {
    const staff = await getStaffRecord(client, request.auth.tenantId, request.params.staffRef, { lock: true });
    await assertTargetOwnerManageable(client, request.auth.tenantId, staff.id, request.auth);
    const nextStatus = request.body.status || staff.status;
    if (staff.id === request.auth.actorId && nextStatus !== 'ACTIVE') throw errors.conflict('SELF_STATUS_CHANGE_NOT_ALLOWED', 'You cannot suspend or disable your own active session');
    if (staff.status === 'ACTIVE' && nextStatus !== 'ACTIVE') await assertLastActiveOwnerPreserved(client, request.auth.tenantId, staff.id);
    const displayName = request.body.display_name?.trim() || staff.display_name;
    await client.query(
      `UPDATE merchant_users
          SET display_name=$1, status=$2,
              disabled_at=CASE WHEN $2='DISABLED' THEN COALESCE(disabled_at,now()) WHEN $2='ACTIVE' THEN NULL ELSE disabled_at END,
              updated_at=now()
        WHERE tenant_id=$3 AND id=$4`,
      [displayName, nextStatus, request.auth.tenantId, staff.id],
    );
    if (nextStatus !== 'ACTIVE') {
      await client.query('UPDATE merchant_sessions SET revoked_at=COALESCE(revoked_at,now()), last_seen_at=now() WHERE tenant_id=$1 AND merchant_user_id=$2 AND revoked_at IS NULL', [request.auth.tenantId, staff.id]);
    }
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
      action: 'merchant.staff.update', targetType: 'merchant_user', targetId: staff.id,
      metadata: { from_status: staff.status, to_status: nextStatus, display_name: displayName }, requestIp: request.ip, requestId: request.id });
    const updated = await getStaffRecord(client, request.auth.tenantId, staff.public_id);
    return { data: { staff: await serializeStaff(client, request.auth.tenantId, updated) } };
  }));

  app.put('/v1/merchant/staff/:staffRef/roles', {
    preHandler: [app.requireMerchantAuth, staffManage, rolesManage], schema: { params: staffParams,
      body: { type: 'object', additionalProperties: false, required: ['role_ids'], properties: {
        role_ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: publicRef },
      } } },
  }, async (request) => app.db.transaction(async (client) => {
    const staff = await getStaffRecord(client, request.auth.tenantId, request.params.staffRef, { lock: true });
    if (staff.id === request.auth.actorId) throw errors.conflict('SELF_ROLE_CHANGE_NOT_ALLOWED', 'Use another OWNER to change your own roles');
    const current = await assertTargetOwnerManageable(client, request.auth.tenantId, staff.id, request.auth);
    const roles = await getRolesByRefs(client, request.auth.tenantId, request.body.role_ids);
    assertCanManageRoles(request.auth, roles);
    const hadOwner = current.some((role) => role.key === 'OWNER');
    const keepsOwner = roles.some((role) => role.key === 'OWNER');
    if (hadOwner && !keepsOwner && staff.status === 'ACTIVE') await assertLastActiveOwnerPreserved(client, request.auth.tenantId, staff.id);
    await client.query('DELETE FROM merchant_user_roles WHERE tenant_id=$1 AND merchant_user_id=$2', [request.auth.tenantId, staff.id]);
    for (const role of roles) await client.query('INSERT INTO merchant_user_roles(tenant_id, merchant_user_id, role_id) VALUES($1,$2,$3)', [request.auth.tenantId, staff.id, role.internal_id]);
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
      action: 'merchant.staff.roles.update', targetType: 'merchant_user', targetId: staff.id,
      metadata: { roles: roles.map((role) => role.key) }, requestIp: request.ip, requestId: request.id });
    return { data: { staff: await serializeStaff(client, request.auth.tenantId, staff) } };
  }));

  app.post('/v1/merchant/staff/:staffRef/reset-password', {
    preHandler: [app.requireMerchantAuth, staffManage], schema: { params: staffParams,
      body: { type: 'object', additionalProperties: false, required: ['new_password'], properties: { new_password: { type: 'string', minLength: 12, maxLength: 128 } } } },
  }, async (request) => {
    const password = assertPasswordPolicy(request.body.new_password);
    return app.db.transaction(async (client) => {
      const staff = await getStaffRecord(client, request.auth.tenantId, request.params.staffRef, { lock: true });
      await assertTargetOwnerManageable(client, request.auth.tenantId, staff.id, request.auth);
      const passwordHash = await hashPassword(password);
      await client.query('UPDATE merchant_users SET password_hash=$1, password_changed_at=now(), updated_at=now() WHERE tenant_id=$2 AND id=$3', [passwordHash, request.auth.tenantId, staff.id]);
      const revoked = await client.query('UPDATE merchant_sessions SET revoked_at=COALESCE(revoked_at,now()), last_seen_at=now() WHERE tenant_id=$1 AND merchant_user_id=$2 AND revoked_at IS NULL RETURNING id', [request.auth.tenantId, staff.id]);
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'merchant.staff.password.reset', targetType: 'merchant_user', targetId: staff.id,
        metadata: { sessions_revoked: revoked.rowCount }, requestIp: request.ip, requestId: request.id });
      return { data: { password_reset: true, sessions_revoked: revoked.rowCount } };
    });
  });

  app.post('/v1/merchant/staff/:staffRef/force-logout', { preHandler: [app.requireMerchantAuth, sessionsManage], schema: { params: staffParams } }, async (request) => app.db.transaction(async (client) => {
    const staff = await getStaffRecord(client, request.auth.tenantId, request.params.staffRef, { lock: true });
    await assertTargetOwnerManageable(client, request.auth.tenantId, staff.id, request.auth);
    const revoked = await client.query('UPDATE merchant_sessions SET revoked_at=COALESCE(revoked_at,now()), last_seen_at=now() WHERE tenant_id=$1 AND merchant_user_id=$2 AND revoked_at IS NULL RETURNING id', [request.auth.tenantId, staff.id]);
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
      action: 'merchant.staff.force_logout', targetType: 'merchant_user', targetId: staff.id,
      metadata: { sessions_revoked: revoked.rowCount }, requestIp: request.ip, requestId: request.id });
    return { data: { logged_out: true, sessions_revoked: revoked.rowCount } };
  }));

  app.get('/v1/merchant/staff/:staffRef/sessions', { preHandler: [app.requireMerchantAuth, staffRead], schema: { params: staffParams } }, async (request) => {
    const staff = await getStaffRecord(app.db.pool, request.auth.tenantId, request.params.staffRef);
    const result = await app.db.query(
      `SELECT public_id AS id, user_agent, request_ip::text AS request_ip, created_at, last_seen_at, expires_at, revoked_at,
              (revoked_at IS NULL AND expires_at > now()) AS active
         FROM merchant_sessions
        WHERE tenant_id=$1 AND merchant_user_id=$2
        ORDER BY created_at DESC
        LIMIT 100`, [request.auth.tenantId, staff.id]);
    return { data: { sessions: result.rows } };
  });

  app.delete('/v1/merchant/staff/:staffRef/sessions/:sessionRef', {
    preHandler: [app.requireMerchantAuth, sessionsManage], schema: { params: { type: 'object', additionalProperties: false, required: ['staffRef', 'sessionRef'], properties: { staffRef: publicRef, sessionRef: publicRef } } },
  }, async (request) => app.db.transaction(async (client) => {
    const staff = await getStaffRecord(client, request.auth.tenantId, request.params.staffRef);
    await assertTargetOwnerManageable(client, request.auth.tenantId, staff.id, request.auth);
    const revoked = await client.query(
      `UPDATE merchant_sessions SET revoked_at=COALESCE(revoked_at,now()), last_seen_at=now()
        WHERE tenant_id=$1 AND merchant_user_id=$2 AND public_id=$3
        RETURNING id`, [request.auth.tenantId, staff.id, request.params.sessionRef]);
    if (!revoked.rowCount) throw errors.notFound('MERCHANT_SESSION_NOT_FOUND', 'Merchant session not found');
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
      action: 'merchant.session.revoke', targetType: 'merchant_session', targetId: revoked.rows[0].id,
      metadata: { merchant_user_id: staff.public_id }, requestIp: request.ip, requestId: request.id });
    return { data: { revoked: true } };
  }));
}
