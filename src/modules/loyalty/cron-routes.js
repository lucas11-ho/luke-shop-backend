import { createHash, timingSafeEqual } from 'node:crypto';
import { errors } from '../../core/errors.js';
import { runAllRecurringVipEntitlements } from './recurring-runner.js';

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function hasValidRunnerToken(request) {
  const configured = process.env.VIP_RECURRING_RUNNER_TOKEN?.trim() || '';
  if (configured.length < 48) return false;

  const authorization = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/.exec(authorization);
  if (!match) return false;

  return timingSafeEqual(digest(configured), digest(match[1]));
}

export async function loyaltyCronRoutes(app) {
  app.post('/internal/jobs/vip-recurring', async (request, reply) => {
    if (!hasValidRunnerToken(request)) {
      throw errors.notFound('ROUTE_NOT_FOUND', 'Route not found');
    }

    const summary = await runAllRecurringVipEntitlements(app.db, {
      now: new Date(),
      batchSize: 5000,
      requestId: request.id,
    });

    request.log.info({
      request_id: request.id,
      stores_processed: summary.stores_processed,
      members_processed: summary.members_processed,
      issued: summary.issued,
      already_issued: summary.already_issued,
      expired: summary.expired,
    }, 'VIP recurring cron completed');

    return reply.send({ data: { summary } });
  });
}
