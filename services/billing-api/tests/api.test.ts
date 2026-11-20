import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ALICE, BOB, SECRET, buildTestApp, seedAliceOctoberBill, tokenFor } from './helpers';

const OCT = { year: 2025, month: 10 };

let ctx: ReturnType<typeof buildTestApp>;
let alice: string;
let bob: string;
let admin: string;

beforeEach(async () => {
  ctx = buildTestApp();
  alice = await tokenFor(ctx.app, ALICE, 'alice-pw');
  bob = await tokenFor(ctx.app, BOB, 'bob-pw');
  admin = await tokenFor(ctx.app, 'admin', 'admin-pw');
});

describe('POST /api/v1/auth/login', () => {
  it('issues a JWT for valid credentials', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login').send({ username: ALICE, password: 'alice-pw' });
    expect(res.status).toBe(200);
    expect(res.body.tokenType).toBe('Bearer');
    const claims = jwt.verify(res.body.accessToken, SECRET) as jwt.JwtPayload;
    expect(claims.sub).toBe(ALICE);
    expect(claims.role).toBe('SUBSCRIBER');
  });

  it('rejects a wrong password with 401', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login').send({ username: ALICE, password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an unknown user with 401', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login').send({ username: 'ghost', password: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/usage (Add Usage)', () => {
  const body = { subscriberNo: ALICE, ...OCT, usageType: 'PHONE' };

  it('adds 10 minutes per phone unit', async () => {
    const res = await request(ctx.app).post('/api/v1/usage').set('Authorization', alice).send(body);
    expect(res.status).toBe(201);
    expect(res.body.record).toMatchObject({ usageType: 'PHONE', amount: 10, unit: 'MINUTES' });
  });

  it('adds 1 MB per internet unit', async () => {
    const res = await request(ctx.app).post('/api/v1/usage').set('Authorization', alice)
      .send({ ...body, usageType: 'INTERNET', units: 5 });
    expect(res.status).toBe(201);
    expect(res.body.record).toMatchObject({ amount: 5, unit: 'MB' });
  });

  it('requires authentication', async () => {
    const res = await request(ctx.app).post('/api/v1/usage').send(body);
    expect(res.status).toBe(401);
  });

  it("forbids adding usage to someone else's account", async () => {
    const res = await request(ctx.app).post('/api/v1/usage').set('Authorization', bob).send(body);
    expect(res.status).toBe(403);
  });

  it('validates usageType and month', async () => {
    const res = await request(ctx.app).post('/api/v1/usage').set('Authorization', alice)
      .send({ ...body, usageType: 'SMS', month: 13 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['usageType', 'month']));
  });

  it('returns 404 for an unknown subscriber (admin)', async () => {
    const res = await request(ctx.app).post('/api/v1/usage').set('Authorization', admin)
      .send({ ...body, subscriberNo: '5559999999' });
    expect(res.status).toBe(404);
  });

  it('rejects a tampered token', async () => {
    const res = await request(ctx.app).post('/api/v1/usage').set('Authorization', `${alice}x`).send(body);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/bills/calculate (Calculate Bill)', () => {
  it('calculates the bill from recorded usage', async () => {
    await seedAliceOctoberBill(ctx.app, alice);
    const res = await request(ctx.app).post('/api/v1/bills/calculate').set('Authorization', alice)
      .send({ subscriberNo: ALICE, ...OCT });
    expect(res.status).toBe(200);
    expect(res.body.bill.charges).toEqual({ phone: 10, internet: 60, total: 70 });
    expect(res.body.bill.usage).toMatchObject({ phoneMinutes: 1500, internetMb: 25_000, internetGb: 25 });
  });

  it('charges only the $50 base fee when there is no usage', async () => {
    const res = await request(ctx.app).post('/api/v1/bills/calculate').set('Authorization', alice)
      .send({ subscriberNo: ALICE, year: 2025, month: 9 });
    expect(res.status).toBe(200);
    expect(res.body.bill.billTotal).toBe(50);
  });

  it('keeps the paid amount when recalculating', async () => {
    await seedAliceOctoberBill(ctx.app, alice);
    await request(ctx.app).post('/api/v1/payments').set('Authorization', alice)
      .send({ subscriberNo: ALICE, ...OCT, amount: 20, transactionId: 'TX-R1' });
    const res = await request(ctx.app).post('/api/v1/bills/calculate').set('Authorization', alice)
      .send({ subscriberNo: ALICE, ...OCT });
    expect(res.body.bill).toMatchObject({ paidAmount: 20, remainingBalance: 50, status: 'PARTIALLY_PAID' });
  });

  it("forbids calculating another subscriber's bill", async () => {
    const res = await request(ctx.app).post('/api/v1/bills/calculate').set('Authorization', bob)
      .send({ subscriberNo: ALICE, ...OCT });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/bills/:subscriberNo (Query Bill)', () => {
  it('returns the bill summary without authentication', async () => {
    await seedAliceOctoberBill(ctx.app, alice);
    const res = await request(ctx.app).get(`/api/v1/bills/${ALICE}`).query(OCT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      subscriberNo: ALICE, year: 2025, month: 10,
      billTotal: 70, paidAmount: 0, remainingBalance: 70, status: 'UNPAID', currency: 'USD',
    });
  });

  it('returns 404 when the bill was not calculated', async () => {
    const res = await request(ctx.app).get(`/api/v1/bills/${ALICE}`).query({ year: 2024, month: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when year/month are missing', async () => {
    const res = await request(ctx.app).get(`/api/v1/bills/${ALICE}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/bills/:subscriberNo/detailed (Query Bill Detailed)', () => {
  beforeEach(async () => {
    await seedAliceOctoberBill(ctx.app, alice);
  });

  it('returns breakdown and paged usage records', async () => {
    const res = await request(ctx.app).get(`/api/v1/bills/${ALICE}/detailed`).set('Authorization', alice)
      .query({ ...OCT, page: 2, pageSize: 1 });
    expect(res.status).toBe(200);
    expect(res.body.charges.total).toBe(70);
    expect(res.body.usageRecords).toMatchObject({ page: 2, pageSize: 1, totalItems: 2, totalPages: 2 });
    expect(res.body.usageRecords.items).toHaveLength(1);
    expect(res.body.usageRecords.items[0].usageType).toBe('INTERNET');
  });

  it('requires authentication', async () => {
    const res = await request(ctx.app).get(`/api/v1/bills/${ALICE}/detailed`).query(OCT);
    expect(res.status).toBe(401);
  });

  it("does not leak another subscriber's details", async () => {
    const res = await request(ctx.app).get(`/api/v1/bills/${ALICE}/detailed`).set('Authorization', bob).query(OCT);
    expect(res.status).toBe(403);
  });

  it('lets an admin view any subscriber', async () => {
    const res = await request(ctx.app).get(`/api/v1/bills/${ALICE}/detailed`).set('Authorization', admin).query(OCT);
    expect(res.status).toBe(200);
  });

  it('rejects pageSize above 100', async () => {
    const res = await request(ctx.app).get(`/api/v1/bills/${ALICE}/detailed`).set('Authorization', alice)
      .query({ ...OCT, pageSize: 500 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/payments (Pay Bill)', () => {
  const pay = (auth: string, amount: number, transactionId: string) =>
    request(ctx.app).post('/api/v1/payments').set('Authorization', auth)
      .send({ subscriberNo: ALICE, ...OCT, amount, transactionId });

  beforeEach(async () => {
    await seedAliceOctoberBill(ctx.app, alice);
  });

  it('records a partial payment', async () => {
    const res = await pay(alice, 30.5, 'TX-1');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      paymentStatus: 'SUCCESS', paymentAmount: 30.5, paidAmount: 30.5, remainingBalance: 39.5, status: 'PARTIALLY_PAID',
    });
  });

  it('records a full payment and marks the bill PAID', async () => {
    await pay(alice, 30, 'TX-1');
    const res = await pay(alice, 40, 'TX-2');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ remainingBalance: 0, status: 'PAID', paymentAmount: 40, paidAmount: 70 });
  });

  it('rejects a duplicate transaction ID and keeps the balance', async () => {
    await pay(alice, 10, 'TX-DUP');
    const res = await pay(alice, 10, 'TX-DUP');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_TRANSACTION');
    const bill = await request(ctx.app).get(`/api/v1/bills/${ALICE}`).query(OCT);
    expect(bill.body.remainingBalance).toBe(60);
  });

  it('rejects an amount above the remaining balance', async () => {
    const res = await pay(alice, 70.01, 'TX-BIG');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
  });

  it('rejects paying an already paid bill', async () => {
    await pay(alice, 70, 'TX-ALL');
    const res = await pay(alice, 1, 'TX-MORE');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BILL_ALREADY_PAID');
  });

  it('rejects zero, negative and 3-decimal amounts', async () => {
    expect((await pay(alice, 0, 'TX-Z')).status).toBe(400);
    expect((await pay(alice, -5, 'TX-N')).status).toBe(400);
    expect((await pay(alice, 1.234, 'TX-D')).status).toBe(400);
  });

  it("forbids paying another subscriber's bill", async () => {
    const res = await pay(bob, 10, 'TX-BOB');
    expect(res.status).toBe(403);
  });

  it('returns 404 when the bill does not exist', async () => {
    const res = await request(ctx.app).post('/api/v1/payments').set('Authorization', alice)
      .send({ subscriberNo: ALICE, year: 2024, month: 1, amount: 5, transactionId: 'TX-404' });
    expect(res.status).toBe(404);
  });

  it('handles concurrent payments without overpaying', async () => {
    const results = await Promise.all([pay(alice, 50, 'TX-C1'), pay(alice, 50, 'TX-C2')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 422]);
  });
});

describe('misc', () => {
  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(ctx.app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(ctx.app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe('Mobile Provider Billing API');
  });
});
