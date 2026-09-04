import { loadConfig } from '../config.js';
import { createDatabase } from '../db/pool.js';
import { runAllRecurringVipEntitlements } from '../modules/loyalty/recurring-runner.js';

const config = loadConfig();
const db = createDatabase(config);

try {
  const totals = await runAllRecurringVipEntitlements(db, {
    now: new Date(),
    batchSize: 5000,
    requestId: 'vip-recurring-entitlements',
  });
  console.log(JSON.stringify(totals, null, 2));
} finally {
  await db.close();
}
