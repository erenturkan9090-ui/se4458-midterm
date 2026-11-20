import { billStatus, type BillBreakdown } from '../domain/billing';
import type { Account, Bill, Payment, Period, UsageRecord } from '../domain/types';
import type { BillingRepository, NewUsage, Page, PaymentTx } from './types';

const key = (p: Period) => `${p.subscriberNo}|${p.year}|${p.month}`;
const samePeriod = (a: Period, b: Period) => key(a) === key(b);

/** In-memory repository used by unit tests (no database needed). */
export class MemoryRepository implements BillingRepository {
  accounts = new Map<string, Account>();
  subscribers = new Set<string>();
  usage: UsageRecord[] = [];
  bills = new Map<string, Bill>();
  payments: Payment[] = [];
  private nextUsageId = 1;
  private lock: Promise<unknown> = Promise.resolve();

  async findAccount(username: string) {
    return this.accounts.get(username) ?? null;
  }

  async subscriberExists(subscriberNo: string) {
    return this.subscribers.has(subscriberNo);
  }

  async addUsage(u: NewUsage) {
    const rec: UsageRecord = { ...u, id: this.nextUsageId++, createdAt: new Date() };
    this.usage.push(rec);
    return rec;
  }

  async sumUsage(p: Period) {
    let phoneMinutes = 0;
    let internetMb = 0;
    for (const u of this.usage.filter((x) => samePeriod(x, p))) {
      if (u.usageType === 'PHONE') phoneMinutes += u.amount;
      else internetMb += u.amount;
    }
    return { phoneMinutes, internetMb };
  }

  async listUsage(p: Period, offset: number, limit: number): Promise<Page<UsageRecord>> {
    const all = this.usage.filter((x) => samePeriod(x, p)).sort((a, b) => a.id - b.id);
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  async upsertBill(p: Period, calc: BillBreakdown) {
    const paidCents = this.bills.get(key(p))?.paidCents ?? 0;
    const bill: Bill = {
      ...p,
      ...calc,
      paidCents,
      status: billStatus(calc.totalCents, paidCents),
      calculatedAt: new Date(),
    };
    this.bills.set(key(p), bill);
    return { ...bill };
  }

  async getBill(p: Period) {
    const b = this.bills.get(key(p));
    return b ? { ...b } : null;
  }

  paymentTransaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T> {
    // Serialize transactions so concurrent payments behave like row locks.
    const tx: PaymentTx = {
      getBillForUpdate: (p) => this.getBill(p),
      transactionExists: async (id) => this.payments.some((x) => x.transactionId === id),
      insertPayment: async (p, transactionId, amountCents) => {
        const pay: Payment = { ...p, transactionId, amountCents, createdAt: new Date() };
        this.payments.push(pay);
        return pay;
      },
      setPaid: async (p, paidCents, status) => {
        const b = this.bills.get(key(p))!;
        b.paidCents = paidCents;
        b.status = status;
        return { ...b };
      },
    };
    const run = this.lock.then(() => fn(tx));
    this.lock = run.catch(() => undefined);
    return run;
  }
}
