import { Pool } from 'pg';
import { createApp } from './app';
import { loadConfig } from './config';
import { PostgresRepository } from './repo/postgres';

const cfg = loadConfig();
const pool = new Pool({
  connectionString: cfg.databaseUrl,
  // Azure Database for PostgreSQL uses a publicly trusted CA, so full verification works.
  ssl: cfg.databaseSsl ? { rejectUnauthorized: true } : undefined,
});

const app = createApp({ repo: new PostgresRepository(pool), jwtSecret: cfg.jwtSecret });
app.listen(cfg.port, () => {
  console.log(`Billing API listening on :${cfg.port}  (Swagger UI: /docs)`);
});
