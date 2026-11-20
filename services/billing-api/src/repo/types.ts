import type { UsageType, BillBreakdown } from '../domain/billing';
import type { Account, Bill, Payment, Period, UsageRecord } from '../domain/types';

export interface NewUsage extends Period {
  usageType: UsageType;
  amount: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

/** Operations available inside a payment transaction (bill row is locked). */
export interface PaymentTx {
  getBillForUpdate(p: Period): Promise<Bill | null>;
  transactionExists(transactionId: string): Promise<boolean>;
  insertPayment(p: Period, transactionId: string, amountCents: number): Promise<Payment>;
  setPaid(p: Period, paidCents: number, status: Bill['status']): Promise<Bill>;
}

export interface BillingRepository {
  findAccount(username: string): Promise<Account | null>;
  subscriberExists(subscriberNo: string): Promise<boolean>;

  addUsage(u: NewUsage): Promise<UsageRecord>;
  sumUsage(p: Period): Promise<{ phoneMinutes: number; internetMb: number }>;
  listUsage(p: Period, offset: number, limit: number): Promise<Page<UsageRecord>>;

  /** Insert or replace the calculated amounts; keeps already paid amount. */
  upsertBill(p: Period, calc: BillBreakdown): Promise<Bill>;
  getBill(p: Period): Promise<Bill | null>;

  /** Runs fn atomically (DB transaction). Throwing inside rolls back. */
  paymentTransaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T>;
}
