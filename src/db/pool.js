import pg from 'pg';

const { Pool } = pg;

export function createDatabase(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    application_name: 'luke-shop-backend',
    options: `-c statement_timeout=${config.dbStatementTimeoutMs}`,
  });

  pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error', { message: error.message });
  });

  return {
    pool,
    query(text, values = []) {
      return pool.query(text, values);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close() {
      return pool.end();
    },
  };
}
