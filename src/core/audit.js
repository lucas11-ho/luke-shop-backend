export async function writeAudit(client, event) {
  await client.query(
    `INSERT INTO audit_logs(
       tenant_id, actor_type, actor_id, action, target_type, target_id,
       metadata, request_ip, request_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [
      event.tenantId,
      event.actorType,
      event.actorId || null,
      event.action,
      event.targetType || null,
      event.targetId || null,
      JSON.stringify(event.metadata || {}),
      event.requestIp || null,
      event.requestId || null,
    ],
  );
}
