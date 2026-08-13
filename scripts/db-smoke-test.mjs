import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/pool.js';

const config = loadConfig();
const db = createDatabase(config);
const client = await db.pool.connect();
try {
  await client.query('BEGIN');
  const suffix = randomUUID().slice(0, 8);
  const t1 = randomUUID(); const t2 = randomUUID();
  const c1 = randomUUID(); const c2 = randomUUID();
  const u1 = randomUUID(); const role2 = randomUUID();
  await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,'T1','ACTIVE'),($4,$5,$6,'T2','ACTIVE')", [t1,`tnt_${suffix}a`,`a-${suffix}`,t2,`tnt_${suffix}b`,`b-${suffix}`]);
  await client.query("INSERT INTO tenant_settings(tenant_id) VALUES($1),($2)", [t1,t2]);
  await client.query("INSERT INTO customers(id,public_id,tenant_id,email,password_hash,display_name,status) VALUES($1,$2,$3,'same@example.com','x','A','ACTIVE'),($4,$5,$6,'same@example.com','x','B','ACTIVE')", [c1,`cus_${suffix}a`,t1,c2,`cus_${suffix}b`,t2]);
  const scoped = await client.query('SELECT public_id FROM customers WHERE tenant_id=$1 AND email=$2',[t1,'same@example.com']);
  assert.equal(scoped.rowCount,1); assert.equal(scoped.rows[0].public_id,`cus_${suffix}a`);
  let sessionRejected=false;
  try { await client.query("INSERT INTO customer_sessions(id,tenant_id,customer_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",[randomUUID(),t1,c2,'a'.repeat(64)]); } catch (e) { sessionRejected = e.code === '23503'; await client.query('ROLLBACK TO SAVEPOINT no_savepoint').catch(()=>{}); }
  // A failed statement aborts the tx; restart a clean transactional section for the remaining checks.
  await client.query('ROLLBACK'); await client.query('BEGIN');
  assert.equal(sessionRejected,true,'cross-tenant customer session FK must fail');
  await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,'T1','ACTIVE'),($4,$5,$6,'T2','ACTIVE')", [t1,`tnt_${suffix}a`,`a-${suffix}`,t2,`tnt_${suffix}b`,`b-${suffix}`]);
  await client.query("INSERT INTO tenant_settings(tenant_id) VALUES($1),($2)", [t1,t2]);
  await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status) VALUES($1,$2,$3,'owner@example.com','x','Owner','ACTIVE')",[u1,`musr_${suffix}`,t1]);
  await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true)",[role2,t2]);
  let roleRejected=false;
  try { await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)',[t1,u1,role2]); } catch (e) { roleRejected=e.code==='23503'; }
  assert.equal(roleRejected,true,'cross-tenant merchant role assignment must fail');
  console.log('PASS live PostgreSQL tenant-isolation smoke checks');
} finally {
  await client.query('ROLLBACK').catch(()=>{});
  client.release();
  await db.close();
}
