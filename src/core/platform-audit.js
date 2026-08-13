export async function writePlatformAudit(client, event) {
  await client.query(
    `INSERT INTO platform_audit_logs(actor_id,action,tenant_id,target_type,target_id,metadata,request_ip,request_id)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [event.actorId || null, event.action, event.tenantId || null, event.targetType || null, event.targetId || null,
      JSON.stringify(event.metadata || {}), event.requestIp || null, event.requestId || null],
  );
}
