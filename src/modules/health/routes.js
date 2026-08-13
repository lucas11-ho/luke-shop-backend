export async function healthRoutes(app) {
  app.get('/health', async () => ({ status: 'ok', release: app.config.release }));
  app.get('/health/live', async () => ({ status: 'ok', release: app.config.release }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await app.db.query('SELECT 1 AS ready');
      return { status: 'ready', release: app.config.release };
    } catch {
      return reply.code(503).send({ status: 'not_ready', release: app.config.release });
    }
  });
}
