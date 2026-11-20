/**
 * Applies db/schema.sql and loads demo data (idempotent).
 * Usage: DATABASE_URL=... npm run db:seed
 */
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { PostgresRepository } from './repo/postgres';
import { BillingService } from './services/billingService';

export const DEMO = {
  admin: { username: 'admin', password: 'admin123' },
  subscribers: [
    { subscriberNo: '5551000001', name: 'Ayse Yilmaz', password: 'pass1234' },
    { subscriberNo: '5551000002', name: 'Mehmet Demir', password: 'pass1234' },
  ],
};

// [subscriberNo, year, month, phone minutes, internet MB]
const USAGE: Array<[string, number, number, number, number]> = [
  ['5551000001', 2025, 9, 800, 18_000], // Sep: $50
  ['5551000001', 2025, 10, 1_500, 25_000], // Oct: $10 phone + $60 internet = $70
  ['5551000002', 2025, 10, 3_200, 41_500], // Oct: $30 phone + $80 internet = $110
];

export async function seed(pool: Pool) {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

  for (const s of DEMO.subscribers) {
    await pool.query(
      'INSERT INTO subscribers (subscriber_no, full_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [s.subscriberNo, s.name],
    );
    await pool.query(
      `INSERT INTO accounts (username, password_hash, role, subscriber_no) VALUES ($1, $2, 'SUBSCRIBER', $1)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [s.subscriberNo, bcrypt.hashSync(s.password, 10)],
    );
  }
  await pool.query(
    `INSERT INTO accounts (username, password_hash, role) VALUES ($1, $2, 'ADMIN')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [DEMO.admin.username, bcrypt.hashSync(DEMO.admin.password, 10)],
  );

  const repo = new PostgresRepository(pool);
  const service = new BillingService(repo, 'seed-only');
  for (const [subscriberNo, year, month, minutes, mb] of USAGE) {
    const p = { subscriberNo, year, month };
    const existing = await repo.sumUsage(p);
    // Seed aggregated rows (equivalent to minutes/10 PHONE units and mb INTERNET units).
    if (existing.phoneMinutes === 0) await repo.addUsage({ ...p, usageType: 'PHONE', amount: minutes });
    if (existing.internetMb === 0) await repo.addUsage({ ...p, usageType: 'INTERNET', amount: mb });
    await service.calculateBill(p);
  }
}

/**
 * Puts the demo back to its starting state: removes all payments, usage and bills
 * (accounts and subscribers stay), then seeds again. Used before recording the demo.
 */
export async function resetDemo(pool: Pool) {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  await pool.query('TRUNCATE payments, bills, usage_records RESTART IDENTITY');
  await seed(pool);
}

if (require.main === module) {
  const reset = process.argv.includes('--reset');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  });
  (reset ? resetDemo(pool) : seed(pool))
    .then(() => console.log(reset ? 'Demo data reset' : 'Seed complete'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
