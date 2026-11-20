import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app';
import { MemoryRepository } from '../src/repo/memory';

export const SECRET = 'test-secret';
export const ALICE = '5551000001';
export const BOB = '5551000002';

export function buildTestApp() {
  const repo = new MemoryRepository();
  const hash = (p: string) => bcrypt.hashSync(p, 4);
  repo.subscribers.add(ALICE).add(BOB);
  repo.accounts.set(ALICE, { username: ALICE, passwordHash: hash('alice-pw'), role: 'SUBSCRIBER', subscriberNo: ALICE });
  repo.accounts.set(BOB, { username: BOB, passwordHash: hash('bob-pw'), role: 'SUBSCRIBER', subscriberNo: BOB });
  repo.accounts.set('admin', { username: 'admin', passwordHash: hash('admin-pw'), role: 'ADMIN', subscriberNo: null });
  const app = createApp({ repo, jwtSecret: SECRET });
  return { app, repo };
}

export async function tokenFor(app: ReturnType<typeof buildTestApp>['app'], username: string, password: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return `Bearer ${res.body.accessToken}`;
}

/** Records usage and calculates the bill for ALICE, Oct 2025: 1500 min + 25,000 MB = $70. */
export async function seedAliceOctoberBill(app: ReturnType<typeof buildTestApp>['app'], auth: string) {
  const base = { subscriberNo: ALICE, year: 2025, month: 10 };
  await request(app).post('/api/v1/usage').set('Authorization', auth).send({ ...base, usageType: 'PHONE', units: 150 });
  await request(app).post('/api/v1/usage').set('Authorization', auth).send({ ...base, usageType: 'INTERNET', units: 25_000 });
  const res = await request(app).post('/api/v1/bills/calculate').set('Authorization', auth).send(base);
  if (res.status !== 200) throw new Error(`calculate failed: ${res.status}`);
}
