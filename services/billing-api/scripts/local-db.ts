/**
 * Docker-free local PostgreSQL for development, using the embedded-postgres npm package.
 * Starts PostgreSQL 18 on port 5432, creates the `billing` database and seeds demo data.
 * Keep this process running; Ctrl+C stops the database.
 *
 * Windows note: initdb fails when its binaries or data dir live under a non-ASCII path
 * (e.g. "OneDrive\Masaüstü") or with a non-ASCII system locale ("Turkish_Türkiye").
 * So the binaries are installed once into ~/.se4458-pg, data goes to ~/.se4458-pgdata,
 * and the cluster is initialised with the neutral C locale.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { seed } from '../src/seed';

const PORT = Number(process.env.LOCAL_PG_PORT ?? 5432);
const PG_HOME = process.env.LOCAL_PG_HOME ?? path.join(os.homedir(), '.se4458-pg');
const DATA_DIR = process.env.LOCAL_PG_DIR ?? path.join(os.homedir(), '.se4458-pgdata');
const PKG_VERSION = '18.7.0-beta.19';

async function loadEmbeddedPostgres() {
  const entry = path.join(PG_HOME, 'node_modules', 'embedded-postgres');
  if (!fs.existsSync(entry)) {
    console.log(`Installing PostgreSQL binaries into ${PG_HOME} (one-time)...`);
    fs.mkdirSync(PG_HOME, { recursive: true });
    fs.writeFileSync(path.join(PG_HOME, 'package.json'), '{"name":"se4458-pg","private":true}');
    execSync(`npm install embedded-postgres@${PKG_VERSION}`, { cwd: PG_HOME, stdio: 'inherit' });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(entry, 'package.json'), 'utf8'));
  const main = pkg.exports?.['.']?.import ?? pkg.exports?.['.']?.default ?? pkg.main ?? 'dist/index.js';
  const mod = await import(pathToFileURL(path.join(entry, typeof main === 'string' ? main : 'dist/index.js')).href);
  return mod.default;
}

async function main() {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'billing',
    password: 'billing',
    port: PORT,
    persistent: true,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
  });

  const fresh = !fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('billing');

  const url = `postgresql://billing:billing@localhost:${PORT}/billing`;
  const pool = new Pool({ connectionString: url });
  await seed(pool);
  await pool.end();

  console.log(`PostgreSQL ready: ${url}`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
