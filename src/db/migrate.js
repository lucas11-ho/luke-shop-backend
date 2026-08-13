import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { createDatabase } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../migrations');

function checksum(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function migrateDatabase(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    const digest = checksum(sql);
    const existing = await db.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== digest) {
        throw new Error(`Applied migration checksum mismatch: ${name}`);
      }
      continue;
    }

    await db.transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES($1, $2)', [name, digest]);
    });
    console.log(`Applied migration ${name}`);
  }
}

async function main() {
  const config = loadConfig();
  const db = createDatabase(config);
  try {
    await migrateDatabase(db);
    console.log('Migrations complete.');
  } finally {
    await db.close();
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
