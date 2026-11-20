import { Router, type Request } from 'express';
import { z } from 'zod';
import { centsToDollars, dollarsToCents, remainingCents } from '../domain/billing';
import { ApiError } from '../domain/errors';
import type { Bill, UsageRecord } from '../domain/types';
import { assertCanAccess, requireAuth } from '../auth/middleware';
import type { BillingService } from '../services/billingService';

const subscriberNo = z.string().trim().regex(/^\d{4,20}$/, 'subscriberNo must be 4-20 digits');
const year = z.coerce.number().int().min(2000).max(2100);
const month = z.coerce.number().int().min(1).max(12);

const loginBody = z.object({ username: z.string().min(1), password: z.string().min(1) });
const usageBody = z.object({
  subscriberNo,
  year,
  month,
  usageType: z.enum(['PHONE', 'INTERNET']),
  units: z.coerce.number().int().min(1).max(100_000).default(1),
});
const periodBody = z.object({ subscriberNo, year, month });
const periodQuery = z.object({ year, month });
const detailedQuery = periodQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const payBody = z.object({
  subscriberNo,
  year,
  month,
  amount: z.number().positive().max(1_000_000),
  transactionId: z.string().trim().min(1).max(64),
});

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Request validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

const subscriberParam = (req: Request) => parse(subscriberNo, req.params.subscriberNo);

export function billView(b: Bill) {
  return {
    subscriberNo: b.subscriberNo,
    year: b.year,
    month: b.month,
    billTotal: centsToDollars(b.totalCents),
    paidAmount: centsToDollars(b.paidCents),
    remainingBalance: centsToDollars(remainingCents(b.totalCents, b.paidCents)),
    status: b.status,
    currency: 'USD',
  };
}

function detailedView(b: Bill) {
  return {
    ...billView(b),
    usage: {
      phoneMinutes: b.phoneMinutes,
      internetMb: b.internetMb,
      internetGb: b.internetMb / 1000,
    },
    charges: {
      phone: centsToDollars(b.phoneChargeCents),
      internet: centsToDollars(b.internetChargeCents),
      total: centsToDollars(b.totalCents),
    },
    calculatedAt: b.calculatedAt,
  };
}

const usageView = (u: UsageRecord) => ({
  id: u.id,
  usageType: u.usageType,
  amount: u.amount,
  unit: u.usageType === 'PHONE' ? 'MINUTES' : 'MB',
  createdAt: u.createdAt,
});

export function v1Router(service: BillingService, jwtSecret: string): Router {
  const r = Router();
  const auth = requireAuth(jwtSecret);

  r.post('/auth/login', async (req, res) => {
    const body = parse(loginBody, req.body);
    const { token, expiresIn } = await service.login(body.username, body.password);
    res.json({ accessToken: token, tokenType: 'Bearer', expiresIn });
  });

  // Add Usage (auth required) - each unit = 10 phone minutes or 1 MB internet
  r.post('/usage', auth, async (req, res) => {
    const body = parse(usageBody, req.body);
    assertCanAccess(req.principal, body.subscriberNo);
    const rec = await service.addUsage(body, body.usageType, body.units);
    res.status(201).json({ status: 'SUCCESS', record: { ...usageView(rec), subscriberNo: rec.subscriberNo, year: rec.year, month: rec.month } });
  });

  // Calculate Bill (auth required)
  r.post('/bills/calculate', auth, async (req, res) => {
    const body = parse(periodBody, req.body);
    assertCanAccess(req.principal, body.subscriberNo);
    const bill = await service.calculateBill(body);
    res.status(200).json({ status: 'SUCCESS', bill: detailedView(bill) });
  });

  // Query Bill (no auth, per spec)
  r.get('/bills/:subscriberNo', async (req, res) => {
    const sno = subscriberParam(req);
    const q = parse(periodQuery, req.query);
    res.json(billView(await service.queryBill({ subscriberNo: sno, ...q })));
  });

  // Query Bill Detailed (auth + paging)
  r.get('/bills/:subscriberNo/detailed', auth, async (req, res) => {
    const sno = subscriberParam(req);
    assertCanAccess(req.principal, sno);
    const q = parse(detailedQuery, req.query);
    const { bill, usage } = await service.queryBillDetailed({ subscriberNo: sno, year: q.year, month: q.month }, q.page, q.pageSize);
    res.json({
      ...detailedView(bill),
      usageRecords: {
        items: usage.items.map(usageView),
        page: q.page,
        pageSize: q.pageSize,
        totalItems: usage.total,
        totalPages: Math.ceil(usage.total / q.pageSize),
      },
    });
  });

  // Pay Bill (auth required) - simulated, no card processing
  r.post('/payments', auth, async (req, res) => {
    const body = parse(payBody, req.body);
    assertCanAccess(req.principal, body.subscriberNo);
    let amountCents: number;
    try {
      amountCents = dollarsToCents(body.amount);
    } catch (e) {
      throw new ApiError('VALIDATION_ERROR', (e as Error).message);
    }
    const result = await service.payBill({ ...body, amountCents });
    res.status(201).json({
      paymentStatus: 'SUCCESS',
      transactionId: result.transactionId,
      paymentAmount: centsToDollars(result.paidAmountCents), // this payment
      ...billView(result.bill), // paidAmount = total paid so far on the bill
    });
  });

  return r;
}
