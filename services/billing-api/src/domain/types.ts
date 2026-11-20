import type { BillStatus, UsageType } from './billing';

export type Role = 'SUBSCRIBER' | 'ADMIN';

export interface Account {
  username: string;
  passwordHash: string;
  role: Role;
  subscriberNo: string | null;
}

export interface Period {
  subscriberNo: string;
  year: number;
  month: number;
}

export interface UsageRecord extends Period {
  id: number;
  usageType: UsageType;
  /** minutes for PHONE, MB for INTERNET */
  amount: number;
  createdAt: Date;
}

export interface Bill extends Period {
  phoneMinutes: number;
  internetMb: number;
  phoneChargeCents: number;
  internetChargeCents: number;
  totalCents: number;
  paidCents: number;
  status: BillStatus;
  calculatedAt: Date;
}

export interface Payment extends Period {
  transactionId: string;
  amountCents: number;
  createdAt: Date;
}
