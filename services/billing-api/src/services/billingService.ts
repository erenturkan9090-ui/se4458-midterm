import bcrypt from 'bcryptjs';
import {
  billStatus,
  calculateBill,
  remainingCents,
  usageAmountForUnits,
  type UsageType,
} from '../domain/billing';
import { ApiError } from '../domain/errors';
import type { Bill, Period, UsageRecord } from '../domain/types';
import { signToken } from '../auth/jwt';
import type { BillingRepository, Page } from '../repo/types';

export interface PayInput extends Period {
  amountCents: number;
  transactionId: string;
}

export class BillingService {
  constructor(
    private readonly repo: BillingRepository,
    private readonly jwtSecret: string,
  ) {}

  async login(username: string, password: string): Promise<{ token: string; expiresIn: number }> {
    const acc = await this.repo.findAccount(username);
    // Compare even when the account is missing so timing doesn't reveal valid usernames.
    const ok = await bcrypt.compare(password, acc?.passwordHash ?? DUMMY_HASH);
    if (!acc || !ok) throw new ApiError('UNAUTHORIZED', 'Invalid username or password');
    const expiresIn = 3600;
    const token = signToken({ username: acc.username, role: acc.role, subscriberNo: acc.subscriberNo }, this.jwtSecret, expiresIn);
    return { token, expiresIn };
  }

  async addUsage(p: Period, usageType: UsageType, units: number): Promise<UsageRecord> {
    await this.assertSubscriber(p.subscriberNo);
    return this.repo.addUsage({ ...p, usageType, amount: usageAmountForUnits(usageType, units) });
  }

  async calculateBill(p: Period): Promise<Bill> {
    await this.assertSubscriber(p.subscriberNo);
    const usage = await this.repo.sumUsage(p);
    return this.repo.upsertBill(p, calculateBill(usage.phoneMinutes, usage.internetMb));
  }

  async queryBill(p: Period): Promise<Bill> {
    const bill = await this.repo.getBill(p);
    if (!bill) throw new ApiError('NOT_FOUND', `No calculated bill for ${p.subscriberNo} ${p.year}-${pad(p.month)}`);
    return bill;
  }

  async queryBillDetailed(p: Period, page: number, pageSize: number): Promise<{ bill: Bill; usage: Page<UsageRecord> }> {
    const bill = await this.queryBill(p);
    const usage = await this.repo.listUsage(p, (page - 1) * pageSize, pageSize);
    return { bill, usage };
  }

  async payBill(input: PayInput): Promise<{ bill: Bill; paidAmountCents: number; transactionId: string }> {
    return this.repo.paymentTransaction(async (tx) => {
      if (await tx.transactionExists(input.transactionId)) {
        throw new ApiError('DUPLICATE_TRANSACTION', `Transaction ${input.transactionId} was already processed`);
      }
      const bill = await tx.getBillForUpdate(input);
      if (!bill) {
        throw new ApiError('NOT_FOUND', `No calculated bill for ${input.subscriberNo} ${input.year}-${pad(input.month)}`);
      }
      const remaining = remainingCents(bill.totalCents, bill.paidCents);
      if (remaining === 0) throw new ApiError('BILL_ALREADY_PAID', 'This bill has no remaining balance');
      if (input.amountCents > remaining) {
        throw new ApiError('AMOUNT_EXCEEDS_BALANCE', `Amount exceeds remaining balance of ${(remaining / 100).toFixed(2)}`, {
          remainingBalance: remaining / 100,
        });
      }
      await tx.insertPayment(input, input.transactionId, input.amountCents);
      const paid = bill.paidCents + input.amountCents;
      const updated = await tx.setPaid(input, paid, billStatus(bill.totalCents, paid));
      return { bill: updated, paidAmountCents: input.amountCents, transactionId: input.transactionId };
    });
  }

  private async assertSubscriber(subscriberNo: string) {
    if (!(await this.repo.subscriberExists(subscriberNo))) {
      throw new ApiError('NOT_FOUND', `Subscriber ${subscriberNo} not found`);
    }
  }
}

const pad = (m: number) => String(m).padStart(2, '0');
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);
