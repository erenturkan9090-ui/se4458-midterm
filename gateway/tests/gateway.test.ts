import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createGateway } from '../src/app';
import { matchRoute } from '../src/routes';

const SECRET = 'test-secret';
const token = (opts: jwt.SignOptions = {}) =>
  jwt.sign({ role: 'SUBSCRIBER', sno: '5551000001' }, SECRET, {
    subject: '5551000001',
    issuer: 'billing-api',
    audience: 'billing-clients',
    expiresIn: 60,
    ...opts,
  });

/** Fake Billing API that echoes what it received. */
let upstream: Server;
let upstreamUrl: string;
const received: { method: string; url: string; headers: Record<string, unknown>; body: unknown }[] = [];

beforeAll(async () => {
  const api = express();
  api.use(express.json());
  api.all(/.*/, (req, res) => {
    received.push({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body });
    if (req.path === '/api/v1/bills/9999') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
      return;
    }
    res.status(req.method === 'POST' ? 201 : 200).json({ ok: true, path: req.originalUrl });
  });
  upstream = await new Promise<Server>((r) => {
    const s = api.listen(0, () => r(s));
  });
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => upstream.close(r)));
beforeEach(() => (received.length = 0));

const gw = (extra: Partial<Parameters<typeof createGateway>[0]> = {}) =>
  createGateway({ upstream: upstreamUrl, jwtSecret: SECRET, log: () => undefined, ...extra });

describe('routing (success)', () => {
  it('forwards a public versioned route to /api/v1 with the query string', async () => {
    const res = await request(gw()).get('/billing/v1/bills/5551000001?year=2025&month=10');
    expect(res.status).toBe(200);
    expect(received[0].url).toBe('/api/v1/bills/5551000001?year=2025&month=10');
    expect(res.headers['x-gateway']).toBe('local');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('forwards a protected route with a valid JWT, including the body and Authorization', async () => {
    const t = token();
    const res = await request(gw())
      .post('/billing/v1/payments')
      .set('Authorization', `Bearer ${t}`)
      .send({ subscriberNo: '5551000001', year: 2025, month: 10, amount: 10, transactionId: 'tx-1' });
    expect(res.status).toBe(201);
    expect(received[0].body).toEqual({ subscriberNo: '5551000001', year: 2025, month: 10, amount: 10, transactionId: 'tx-1' });
    expect(received[0].headers.authorization).toBe(`Bearer ${t}`);
    expect(received[0].headers['x-gateway-route']).toBe('pay-bill');
  });

  it('passes backend errors through unchanged', async () => {
    const res = await request(gw()).get('/billing/v1/bills/9999?year=2025&month=1');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Bill not found' });
  });

  it('matches the literal /bills/calculate before /bills/{subscriberNo}', () => {
    expect(matchRoute('POST', '/bills/calculate')).toMatchObject({ kind: 'match', route: { id: 'calculate-bill' } });
    expect(matchRoute('GET', '/bills/5551000001')).toMatchObject({ kind: 'match', route: { id: 'query-bill' } });
  });

  it('lists the published routes', async () => {
    const res = await request(gw()).get('/billing/v1/_routes');
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([
      'login', 'add-usage', 'calculate-bill', 'query-bill', 'query-bill-detailed', 'pay-bill',
    ]);
  });
});

describe('gateway errors (failure)', () => {
  it('401 on a protected route without a token, never reaching the API', async () => {
    const res = await request(gw()).get('/billing/v1/bills/5551000001/detailed?year=2025&month=10');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', source: 'gateway' });
    expect(received).toHaveLength(0);
  });

  it('401 for an expired or wrongly signed token', async () => {
    const expired = token({ expiresIn: -10 });
    const forged = jwt.sign({ role: 'ADMIN' }, 'other-secret', { issuer: 'billing-api', audience: 'billing-clients' });
    for (const t of [expired, forged]) {
      const res = await request(gw()).post('/billing/v1/usage').set('Authorization', `Bearer ${t}`).send({});
      expect(res.status).toBe(401);
    }
    expect(received).toHaveLength(0);
  });

  it('404 for unpublished routes and versions (including direct /api/v1)', async () => {
    for (const path of ['/billing/v1/admin', '/billing/v2/bills/5551000001', '/api/v1/bills/5551000001']) {
      const res = await request(gw()).get(path);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', source: 'gateway' });
    }
    expect(received).toHaveLength(0);
  });

  it('405 with Allow header for a wrong method', async () => {
    const res = await request(gw()).delete('/billing/v1/payments');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('401 when a subscription key is required and missing; key is not forwarded upstream', async () => {
    const app = gw({ subscriptionKey: 'k-123' });
    expect((await request(app).get('/billing/v1/bills/5551000001?year=2025&month=10')).status).toBe(401);
    const ok = await request(app)
      .get('/billing/v1/bills/5551000001?year=2025&month=10')
      .set('Ocp-Apim-Subscription-Key', 'k-123');
    expect(ok.status).toBe(200);
    expect(received[0].headers['ocp-apim-subscription-key']).toBeUndefined();
  });

  it('429 with Retry-After once the rate limit is exceeded', async () => {
    const app = gw({ rateLimit: { limit: 2, windowMs: 60_000 } });
    const path = '/billing/v1/bills/5551000001?year=2025&month=10';
    expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).get(path)).status).toBe(200);
    const limited = await request(app).get(path);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('502 when the billing service is down', async () => {
    const res = await request(createGateway({ upstream: 'http://127.0.0.1:1', log: () => undefined }))
      .get('/billing/v1/bills/5551000001?year=2025&month=10');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'BAD_GATEWAY', source: 'gateway' });
  });
});
