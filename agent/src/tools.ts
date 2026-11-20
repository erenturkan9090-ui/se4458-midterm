/**
 * Tool layer between the LLM and the outside world.
 *
 * Safety rules are enforced HERE, in code, not only in the prompt:
 * 1. Identity: REST tools act on the logged-in subscriber. A SUBSCRIBER session's tools
 *    have no subscriberNo parameter at all, so a number typed into the chat cannot
 *    redirect a call to another person's account. (The API also returns 403.)
 * 2. Payments: pay_bill never runs until the human confirms the exact subscriber,
 *    period and amount through the `confirmPayment` callback (Billing Guide §5.2).
 *    The model cannot answer that prompt for the user.
 * 3. Idempotency: each confirmed payment gets one transactionId; a network retry
 *    reuses it, so the API rejects a duplicate instead of charging twice (§5.3).
 */
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { GatewayError, type GatewayClient, type Session } from './gatewayClient';
import type { McpGateway } from './mcpClient';
import type { TraceRecorder } from './trace';

export interface PaymentRequest {
  subscriberNo: string;
  year: number;
  month: number;
  amount: number;
  billTotal?: number;
  remainingBalance?: number;
}

/** Asks the human (not the model) to approve a payment. Resolve true only on an explicit yes. */
export type ConfirmPayment = (req: PaymentRequest) => Promise<boolean>;

export interface ToolOutcome {
  ok: boolean;
  /** JSON-serialisable result returned to the model as the tool_result. */
  result: unknown;
}

const period = {
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
};
const subscriberField = z.string().regex(/^\d{4,20}$/);

const periodSchema = (admin: boolean) => ({
  type: 'object' as const,
  properties: {
    ...(admin
      ? { subscriberNo: { type: 'string', description: 'Subscriber number (admin sessions only)' } }
      : {}),
    year: { type: 'integer', description: 'Billing year, e.g. 2025' },
    month: { type: 'integer', minimum: 1, maximum: 12, description: 'Billing month 1-12' },
  },
  required: admin ? ['subscriberNo', 'year', 'month'] : ['year', 'month'],
});

export class ToolRegistry {
  private mcpTools: Anthropic.Beta.BetaTool[] = [];
  private turn = 0;

  constructor(
    private readonly session: Session,
    private readonly gateway: GatewayClient,
    private readonly mcp: McpGateway,
    private readonly confirmPayment: ConfirmPayment,
    private readonly trace: TraceRecorder,
  ) {}

  private get isAdmin() {
    return this.session.role === 'ADMIN';
  }

  /** Loads the MCP server's tool list (tool discovery) once per session. */
  async init(): Promise<void> {
    const tools = await this.mcp.listTools();
    this.mcpTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    }));
  }

  setTurn(turn: number) {
    this.turn = turn;
  }

  isMcpTool(name: string) {
    return this.mcpTools.some((t) => t.name === name);
  }

  definitions(): Anthropic.Beta.BetaTool[] {
    const who = this.isAdmin
      ? 'the subscriber given in subscriberNo'
      : `the logged-in subscriber (${this.session.subscriberNo}); it cannot access any other subscriber`;
    const rest: Anthropic.Beta.BetaTool[] = [
      {
        name: 'get_bill',
        description:
          `Billing REST API "Query Bill" (via the API Gateway) for ${who}. Returns the STORED bill for a month: ` +
          'billTotal, paidAmount, remainingBalance, status (UNPAID/PARTIALLY_PAID/PAID). 404 means no bill was calculated for that month.',
        input_schema: periodSchema(this.isAdmin),
      },
      {
        name: 'get_bill_details',
        description:
          `Billing REST API "Query Bill Detailed" (via the API Gateway) for ${who}. Returns the stored bill plus usage totals ` +
          '(phone minutes, internet MB/GB), the phone/internet charge breakdown and paged usage records. ' +
          'Use it to explain why a bill has a certain amount.',
        input_schema: {
          ...periodSchema(this.isAdmin),
          properties: {
            ...periodSchema(this.isAdmin).properties,
            page: { type: 'integer', minimum: 1, description: 'Usage-record page (default 1)' },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, description: 'Records per page (default 20)' },
          },
        },
      },
      {
        name: 'pay_bill',
        description:
          `Billing REST API "Pay Bill" (via the API Gateway) for ${who}. Pays all or part of a stored bill. ` +
          'Only call it after the user has clearly asked to pay a specific amount for a specific month. ' +
          'The system will then show the user the subscriber, period and amount and ask for explicit confirmation; ' +
          'if the user declines, the result says so and nothing is paid. Never claim a payment succeeded unless this tool returned paymentStatus SUCCESS.',
        input_schema: {
          type: 'object',
          properties: {
            ...periodSchema(this.isAdmin).properties,
            amount: { type: 'number', description: 'Amount in USD, at most 2 decimals, e.g. 70 or 30.50' },
          },
          required: [...periodSchema(this.isAdmin).required, 'amount'],
        },
      },
    ];
    return [...this.mcpTools, ...rest];
  }

  /** Resolves which subscriber a REST call acts on. Never trusts a number from the model for SUBSCRIBER sessions. */
  private subscriberFor(input: Record<string, unknown>): string {
    if (this.isAdmin) return subscriberField.parse(input.subscriberNo);
    const own = this.session.subscriberNo;
    if (!own) throw new GatewayError(403, 'FORBIDDEN', 'This session has no subscriber number.');
    if (input.subscriberNo !== undefined && String(input.subscriberNo) !== own) {
      throw new GatewayError(
        403,
        'FORBIDDEN',
        `This session can only access subscriber ${own}. Requests for other subscribers are refused.`,
      );
    }
    return own;
  }

  async execute(name: string, rawInput: unknown): Promise<ToolOutcome> {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const started = Date.now();
    const http: string[] = [];
    const callGateway = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } finally {
        const c = this.gateway.lastCall;
        if (c) http.push(`${c.method} ${c.path} -> ${c.status}`);
        this.gateway.lastCall = null;
      }
    };

    let outcome: ToolOutcome;
    try {
      outcome = this.isMcpTool(name)
        ? await this.runMcp(name, input)
        : await this.runRest(name, input, callGateway);
    } catch (err) {
      outcome = { ok: false, result: toErrorResult(err) };
    }

    this.trace.record({
      turn: this.turn,
      tool: name,
      source: this.isMcpTool(name) ? 'MCP' : name === 'pay_bill' || name.startsWith('get_bill') ? 'REST' : 'AGENT',
      input,
      ok: outcome.ok,
      http: http.length ? http : undefined,
      output: outcome.result,
      ms: Date.now() - started,
    });
    return outcome;
  }

  private async runMcp(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const r = await this.mcp.callTool(name, input);
    return { ok: !r.isError, result: r.data };
  }

  private async runRest(
    name: string,
    input: Record<string, unknown>,
    call: <T>(fn: () => Promise<T>) => Promise<T>,
  ): Promise<ToolOutcome> {
    const token = this.session.accessToken;
    switch (name) {
      case 'get_bill': {
        const p = z.object(period).parse(input);
        const sno = this.subscriberFor(input);
        return { ok: true, result: await call(() => this.gateway.queryBill(sno, p.year, p.month)) };
      }
      case 'get_bill_details': {
        const p = z
          .object({
            ...period,
            page: z.number().int().min(1).optional(),
            pageSize: z.number().int().min(1).max(100).optional(),
          })
          .parse(input);
        const sno = this.subscriberFor(input);
        return {
          ok: true,
          result: await call(() => this.gateway.queryBillDetailed(token, sno, p.year, p.month, p.page, p.pageSize)),
        };
      }
      case 'pay_bill': {
        const p = z.object({ ...period, amount: z.number().positive() }).parse(input);
        const sno = this.subscriberFor(input);
        // Show the human the stored bill next to the requested amount (Guide §4.4: no estimates).
        const bill = (await call(() => this.gateway.queryBill(sno, p.year, p.month))) as {
          billTotal?: number;
          remainingBalance?: number;
        };
        const approved = await this.confirmPayment({
          subscriberNo: sno,
          year: p.year,
          month: p.month,
          amount: p.amount,
          billTotal: bill.billTotal,
          remainingBalance: bill.remainingBalance,
        });
        if (!approved) {
          return {
            ok: false,
            result: {
              paymentStatus: 'NOT_SUBMITTED',
              reason: 'The user did not confirm the payment. Nothing was paid.',
            },
          };
        }
        const transactionId = `agent-${randomUUID()}`;
        const body = { subscriberNo: sno, year: p.year, month: p.month, amount: p.amount, transactionId };
        try {
          return { ok: true, result: await call(() => this.gateway.payBill(token, body)) };
        } catch (err) {
          if (err instanceof GatewayError) throw err;
          // Network failure: the request may or may not have reached the API.
          // Retry once with the SAME transactionId; a 409 then means the first attempt succeeded.
          try {
            return { ok: true, result: await call(() => this.gateway.payBill(token, body)) };
          } catch (retryErr) {
            if (retryErr instanceof GatewayError && retryErr.code === 'DUPLICATE_TRANSACTION') {
              return {
                ok: true,
                result: {
                  paymentStatus: 'SUCCESS',
                  transactionId,
                  note: 'First attempt reached the API; retry was rejected as a duplicate, so the payment was recorded once.',
                },
              };
            }
            throw retryErr;
          }
        }
      }
      default:
        return { ok: false, result: { error: { code: 'UNKNOWN_TOOL', message: `No tool named ${name}` } } };
    }
  }
}

export function toErrorResult(err: unknown) {
  if (err instanceof GatewayError) {
    return { error: { httpStatus: err.status, code: err.code, message: err.message, details: err.details } };
  }
  if (err instanceof z.ZodError) {
    return {
      error: {
        code: 'INVALID_TOOL_INPUT',
        message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      },
    };
  }
  return { error: { code: 'TOOL_FAILED', message: err instanceof Error ? err.message : String(err) } };
}
