import { loadConfig } from '../config.js';
import { createDatabase } from '../db/pool.js';

const config=loadConfig(); const db=createDatabase(config);
try {
  const nonces=await db.query(`DELETE FROM customer_service_request_nonces WHERE expires_at<now()`);
  const contexts=await db.query(`DELETE FROM customer_service_contexts WHERE expires_at<now()-interval '1 day'`);
  console.log(JSON.stringify({deleted_nonces:nonces.rowCount,deleted_contexts:contexts.rowCount}));
} finally { await db.close(); }
