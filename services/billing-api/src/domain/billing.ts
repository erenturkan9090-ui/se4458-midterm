/**
 * Pure billing rules (no I/O). All money values are integer cents.
 *
 * Phone:    first 1,000 minutes free, then $10 per *started* 1,000-minute block.
 * Internet: $50 flat for up to 20 GB, then $10 per *started* additional 10 GB block.
 *           1 GB = 1,000 MB for this assignment.
 */

export const PHONE_FREE_MINUTES = 1000;
export const PHONE_BLOCK_MINUTES = 1000;
export const PHONE_BLOCK_PRICE_CENTS = 10_00;

export const MB_PER_GB = 1000;
export const INTERNET_INCLUDED_MB = 20 * MB_PER_GB;
export const INTERNET_BASE_PRICE_CENTS = 50_00;
export const INTERNET_BLOCK_MB = 10 * MB_PER_GB;
export const INTERNET_BLOCK_PRICE_CENTS = 10_00;

/** One "Add Usage" unit, as defined in the spec. */
export const PHONE_MINUTES_PER_UNIT = 10;
export const INTERNET_MB_PER_UNIT = 1;

export type UsageType = 'PHONE' | 'INTERNET';
export type BillStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export function usageAmountForUnits(type: UsageType, units: number): number {
  return type === 'PHONE' ? units * PHONE_MINUTES_PER_UNIT : units * INTERNET_MB_PER_UNIT;
}

export function phoneChargeCents(minutes: number): number {
  assertNonNegativeInt(minutes, 'minutes');
  const over = Math.max(0, minutes - PHONE_FREE_MINUTES);
  return Math.ceil(over / PHONE_BLOCK_MINUTES) * PHONE_BLOCK_PRICE_CENTS;
}

export function internetChargeCents(mb: number): number {
  assertNonNegativeInt(mb, 'mb');
  const over = Math.max(0, mb - INTERNET_INCLUDED_MB);
  return INTERNET_BASE_PRICE_CENTS + Math.ceil(over / INTERNET_BLOCK_MB) * INTERNET_BLOCK_PRICE_CENTS;
}

export interface BillBreakdown {
  phoneMinutes: number;
  internetMb: number;
  phoneChargeCents: number;
  internetChargeCents: number;
  totalCents: number;
}

export function calculateBill(phoneMinutes: number, internetMb: number): BillBreakdown {
  const phone = phoneChargeCents(phoneMinutes);
  const internet = internetChargeCents(internetMb);
  return {
    phoneMinutes,
    internetMb,
    phoneChargeCents: phone,
    internetChargeCents: internet,
    totalCents: phone + internet,
  };
}

export function remainingCents(totalCents: number, paidCents: number): number {
  return Math.max(0, totalCents - paidCents);
}

export function billStatus(totalCents: number, paidCents: number): BillStatus {
  if (paidCents <= 0) return totalCents === 0 ? 'PAID' : 'UNPAID';
  return paidCents >= totalCents ? 'PAID' : 'PARTIALLY_PAID';
}

/** Converts a dollar amount (max 2 decimals) to integer cents; throws on more precision. */
export function dollarsToCents(amount: number): number {
  const cents = Math.round(amount * 100);
  if (Math.abs(cents - amount * 100) > 1e-6) {
    throw new RangeError('amount must have at most 2 decimal places');
  }
  return cents;
}

export const centsToDollars = (cents: number): number => cents / 100;

function assertNonNegativeInt(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer`);
}
