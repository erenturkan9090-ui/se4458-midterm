import {
  billStatus,
  calculateBill,
  dollarsToCents,
  internetChargeCents,
  phoneChargeCents,
  remainingCents,
  usageAmountForUnits,
} from '../src/domain/billing';

describe('phone charge', () => {
  it.each([
    [0, 0],
    [1000, 0], // exactly the free allowance
    [1001, 1000], // one started block
    [2000, 1000],
    [2001, 2000],
    [5500, 5000],
  ])('%i minutes -> %i cents', (min, cents) => {
    expect(phoneChargeCents(min)).toBe(cents);
  });

  it('rejects negative / fractional minutes', () => {
    expect(() => phoneChargeCents(-1)).toThrow(RangeError);
    expect(() => phoneChargeCents(1.5)).toThrow(RangeError);
  });
});

describe('internet charge', () => {
  it.each([
    [0, 5000], // base fee applies even with no usage
    [20_000, 5000], // exactly 20 GB
    [20_001, 6000], // 1 MB over -> one started 10 GB block
    [30_000, 6000],
    [30_001, 7000],
    [45_000, 8000],
  ])('%i MB -> %i cents', (mb, cents) => {
    expect(internetChargeCents(mb)).toBe(cents);
  });

  it('rejects negative MB', () => {
    expect(() => internetChargeCents(-5)).toThrow(RangeError);
  });
});

describe('calculateBill', () => {
  it('sums phone and internet charges', () => {
    expect(calculateBill(1500, 25_000)).toEqual({
      phoneMinutes: 1500,
      internetMb: 25_000,
      phoneChargeCents: 1000,
      internetChargeCents: 6000,
      totalCents: 7000,
    });
  });
});

describe('usage units', () => {
  it('1 phone unit = 10 minutes, 1 internet unit = 1 MB', () => {
    expect(usageAmountForUnits('PHONE', 3)).toBe(30);
    expect(usageAmountForUnits('INTERNET', 3)).toBe(3);
  });
});

describe('status and balance', () => {
  it('derives status from paid amount', () => {
    expect(billStatus(7000, 0)).toBe('UNPAID');
    expect(billStatus(7000, 100)).toBe('PARTIALLY_PAID');
    expect(billStatus(7000, 7000)).toBe('PAID');
  });

  it('never returns a negative remaining balance', () => {
    expect(remainingCents(5000, 6000)).toBe(0);
  });
});

describe('dollarsToCents', () => {
  it('converts valid amounts', () => {
    expect(dollarsToCents(30.5)).toBe(3050);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30); // float noise tolerated
  });

  it('rejects more than 2 decimals', () => {
    expect(() => dollarsToCents(1.234)).toThrow(RangeError);
  });
});
