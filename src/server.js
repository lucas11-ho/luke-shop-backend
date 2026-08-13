import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  const shutdown = async (signal) => {
    app.log.info({ signal }, 'Shutdown requested');
    try { await app.close(); }
    finally { process.exit(0); }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error('Luke Shop Backend failed to start:', error.message);
  process.exitCode = 1;
});
