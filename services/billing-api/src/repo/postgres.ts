import { Pool, type PoolClient } from 'pg';
import { billStatus, type BillBreakdown } from '../domain/billing';
import type { Bill, Payment, Period, UsageRecord } from '../domain/types';
import type { BillingRepository, NewUsage, Page, PaymentTx } from './types';

const BILL_COLS = `subscriber_no, year, month, phone_minutes, internet_mb, phone_charge_cents,
  internet_charge_cents, total_cents, paid_cents, status, calculated_at`;

function toBill(r: any): Bill {
  return {
    subscriberNo: r.subscriber_no,
    year: r.year,
    month: r.month,
    phoneMinutes: r.phone_minutes,
    internetMb: r.internet_mb,
    phoneChargeCents: r.phone_charge_cents,
    internetChargeCents: r.internet_charge_cents,
    totalCents: r.total_cents,
    paidCents: r.paid_cents,
    status: r.status,
    calculatedAt: r.calculated_at,
  };
}

function toUsage(r: any): UsageRecord {
  return {
    id: Number(r.id),
    subscriberNo: r.subscriber_no,
    year: r.year,
    month: r.month,
    usageType: r.usage_type,
    amount: r.amount,
    createdAt: r.created_at,
  };
}

export class PostgresRepository implements BillingRepository {
  constructor(private readonly pool: Pool) {}

  async findAccount(username: string) {
    const { rows } = await this.pool.query(
      'SELECT username, password_hash, role, subscriber_no FROM accounts WHERE username = $1',
      [username],
    );
    const r = rows[0];
    return r ? { username: r.username, passwordHash: r.password_hash, role: r.role, subscriberNo: r.subscriber_no } : null;
  }

  async subscriberExists(subscriberNo: string) {
    const { rowCount } = await this.pool.query('SELECT 1 FROM subscribers WHERE subscriber_no = $1', [subscriberNo]);
    return (rowCount ?? 0) > 0;
  }

  async addUsage(u: NewUsage) {
    const { rows } = await this.pool.query(
      `INSERT INTO usage_records (subscriber_no, year, month, usage_type, amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [u.subscriberNo, u.year, u.month, u.usageType, u.amount],
    );
    return toUsage(rows[0]);
  }

  async sumUsage(p: Period) {
    const { rows } = await this.pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE usage_type = 'PHONE'), 0)::int    AS phone,
         COALESCE(SUM(amount) FILTER (WHERE usage_type = 'INTERNET'), 0)::int AS internet
       FROM usage_records WHERE subscriber_no = $1 AND year = $2 AND month = $3`,
      [p.subscriberNo, p.year, p.month],
    );
    return { phoneMinutes: rows[0].phone, internetMb: rows[0].internet };
  }

  async listUsage(p: Period, offset: number, limit: number): Promise<Page<UsageRecord>> {
    const args = [p.subscriberNo, p.year, p.month];
    const where = 'WHERE subscriber_no = $1 AND year = $2 AND month = $3';
    const [items, count] = await Promise.all([
      this.pool.query(`SELECT * FROM usage_records ${where} ORDER BY id LIMIT $4 OFFSET $5`, [...args, limit, offset]),
      this.pool.query(`SELECT COUNT(*)::int AS n FROM usage_records ${where}`, args),
    ]);
    return { items: items.rows.map(toUsage), total: count.rows[0].n };
  }

  async upsertBill(p: Period, c: BillBreakdown) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT paid_cents FROM bills WHERE subscriber_no = $1 AND year = $2 AND month = $3 FOR UPDATE',
        [p.subscriberNo, p.year, p.month],
      );
      const paid = existing.rows[0]?.paid_cents ?? 0;
      const { rows } = await client.query(
        `INSERT INTO bills (${BILL_COLS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (subscriber_no, year, month) DO UPDATE SET
           phone_minutes = EXCLUDED.phone_minutes, internet_mb = EXCLUDED.internet_mb,
           phone_charge_cents = EXCLUDED.phone_charge_cents, internet_charge_cents = EXCLUDED.internet_charge_cents,
           total_cents = EXCLUDED.total_cents, status = EXCLUDED.status, calculated_at = now()
         RETURNING ${BILL_COLS}`,
        [p.subscriberNo, p.year, p.month, c.phoneMinutes, c.internetMb, c.phoneChargeCents,
          c.internetChargeCents, c.totalCents, paid, billStatus(c.totalCents, paid)],
      );
      await client.query('COMMIT');
      return toBill(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getBill(p: Period) {
    const { rows } = await this.pool.query(
      `SELECT ${BILL_COLS} FROM bills WHERE subscriber_no = $1 AND year = $2 AND month = $3`,
      [p.subscriberNo, p.year, p.month],
    );
    return rows[0] ? toBill(rows[0]) : null;
  }

  async paymentTransaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(this.txOps(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private txOps(c: PoolClient): PaymentTx {
    return {
      getBillForUpdate: async (p) => {
        const { rows } = await c.query(
          `SELECT ${BILL_COLS} FROM bills WHERE subscriber_no = $1 AND year = $2 AND month = $3 FOR UPDATE`,
          [p.subscriberNo, p.year, p.month],
        );
        return rows[0] ? toBill(rows[0]) : null;
      },
      transactionExists: async (id) => {
        const { rowCount } = await c.query('SELECT 1 FROM payments WHERE transaction_id = $1', [id]);
        return (rowCount ?? 0) > 0;
      },
      insertPayment: async (p, transactionId, amountCents): Promise<Payment> => {
        const { rows } = await c.query(
          `INSERT INTO payments (transaction_id, subscriber_no, year, month, amount_cents)
           VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
          [transactionId, p.subscriberNo, p.year, p.month, amountCents],
        );
        return { ...p, transactionId, amountCents, createdAt: rows[0].created_at };
      },
      setPaid: async (p, paidCents, status) => {
        const { rows } = await c.query(
          `UPDATE bills SET paid_cents = $4, status = $5
           WHERE subscriber_no = $1 AND year = $2 AND month = $3 RETURNING ${BILL_COLS}`,
          [p.subscriberNo, p.year, p.month, paidCents, status],
        );
        return toBill(rows[0]);
      },
    };
  }
}
