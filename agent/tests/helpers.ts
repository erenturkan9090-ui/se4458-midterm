import type Anthropic from '@anthropic-ai/sdk';
import { GatewayClient, type FetchLike, type Session } from '../src/gatewayClient';
import type { LlmClient, LlmRequest } from '../src/llm';
import type { McpGateway } from '../src/mcpClient';
import { ToolRegistry, type ConfirmPayment, type PaymentRequest } from '../src/tools';
import { TraceRecorder } from '../src/trace';
import { BillingAgent, systemPrompt } from '../src/agent';

export const ALICE: Session = {
  accessToken: 'alice-token',
  username: '5551000001',
  role: 'SUBSCRIBER',
  subscriberNo: '5551000001',
};

let idCounter = 0;
export const toolUse = (name: string, input: Record<string, unknown>): Anthropic.Beta.BetaToolUseBlock =>
  ({ type: 'tool_use', id: `toolu_${++idCounter}`, name, input }) as Anthropic.Beta.BetaToolUseBlock;
export const text = (t: string): Anthropic.Beta.BetaTextBlock =>
  ({ type: 'text', text: t, citations: null }) as Anthropic.Beta.BetaTextBlock;

export function message(
  content: Anthropic.Beta.BetaContentBlock[],
  stop_reason: Anthropic.Beta.BetaStopReason,
): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${++idCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** Returns the scripted responses in order and records every request it received. */
export class ScriptedLlm implements LlmClient {
  readonly model = 'scripted';
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: Anthropic.Beta.BetaMessage[]) {}
  async create(req: LlmRequest) {
    this.requests.push({ ...req, messages: [...req.messages] });
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedLlm ran out of responses');
    return next;
  }
}

export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
}

/**
 * Minimal stand-in for the gateway + Billing API. Knows two subscribers and enforces
 * the same rules as the real API (auth on detailed/payments, 403 for other subscribers).
 */
export function fakeGateway(opts: { failNetworkOnce?: boolean } = {}) {
  const calls: FakeCall[] = [];
  const bills: Record<string, any> = {
    '5551000001-2025-10': { subscriberNo: '5551000001', year: 2025, month: 10, billTotal: 70, paidAmount: 0, remainingBalance: 70, status: 'UNPAID', currency: 'USD' },
    '5551000002-2025-10': { subscriberNo: '5551000002', year: 2025, month: 10, billTotal: 110, paidAmount: 0, remainingBalance: 110, status: 'UNPAID', currency: 'USD' },
  };
  const seenTx = new Set<string>();
  let failNext = opts.failNetworkOnce ?? false;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });

  const fetchFn: FetchLike = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, headers, body });
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, '');
    const authed = headers.Authorization === 'Bearer alice-token' ? '5551000001' : null;

    let m = /^\/bills\/(\d+)(\/detailed)?$/.exec(path);
    if (init.method === 'GET' && m) {
      const [, sno, detailed] = m;
      if (detailed) {
        if (!authed) return err(401, 'UNAUTHORIZED', 'Missing bearer token');
        if (authed !== sno) return err(403, 'FORBIDDEN', 'Not your subscriber');
      }
      const bill = bills[`${sno}-${u.searchParams.get('year')}-${u.searchParams.get('month')}`];
      if (!bill) return err(404, 'NOT_FOUND', 'Bill not found for this period');
      return json(200, detailed
        ? { ...bill, usage: { phoneMinutes: 1500, internetMb: 25000, internetGb: 25 }, charges: { phone: 10, internet: 60, total: 70 } }
        : bill);
    }
    if (init.method === 'POST' && path === '/payments') {
      if (failNext) {
        failNext = false;
        seenTx.add(body.transactionId); // the request reached the API, but the response was lost
        throw new TypeError('fetch failed');
      }
      if (!authed) return err(401, 'UNAUTHORIZED', 'Missing bearer token');
      if (authed !== body.subscriberNo) return err(403, 'FORBIDDEN', 'Not your subscriber');
      if (seenTx.has(body.transactionId)) return err(409, 'DUPLICATE_TRANSACTION', 'Duplicate transactionId');
      seenTx.add(body.transactionId);
      const bill = bills[`${body.subscriberNo}-${body.year}-${body.month}`];
      bill.paidAmount += body.amount;
      bill.remainingBalance = bill.billTotal - bill.paidAmount;
      bill.status = bill.remainingBalance === 0 ? 'PAID' : 'PARTIALLY_PAID';
      return json(201, { paymentStatus: 'SUCCESS', transactionId: body.transactionId, paymentAmount: body.amount, ...bill });
    }
    return err(404, 'NOT_FOUND', 'Route not found');
  };

  return { calls, bills, client: new GatewayClient('http://gw.test/api/v1', 'sub-key', fetchFn) };
}

export function fakeMcp(): McpGateway & { calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async listTools() {
      return [
        {
          name: 'search_billing_documentation',
          description: 'Search the billing guide',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return {
        isError: false,
        data: {
          document: 'Mobile_Provider_Billing_Guide.md',
          documentId: 'MOB-BILLING-2026-01',
          matches: [{ section: '3.2', heading: 'Additional internet blocks', text: 'Each additional 10 GB block costs $10.' }],
        },
      };
    },
    async close() {},
  };
}

export async function buildAgent(
  script: Anthropic.Beta.BetaMessage[],
  opts: { confirm?: boolean; session?: Session; failNetworkOnce?: boolean } = {},
) {
  const gw = fakeGateway({ failNetworkOnce: opts.failNetworkOnce });
  const mcp = fakeMcp();
  const trace = new TraceRecorder();
  const confirmRequests: PaymentRequest[] = [];
  const confirm: ConfirmPayment = async (req) => {
    confirmRequests.push(req);
    return opts.confirm ?? false;
  };
  const session = opts.session ?? ALICE;
  const tools = new ToolRegistry(session, gw.client, mcp, confirm, trace);
  await tools.init();
  const llm = new ScriptedLlm(script);
  const agent = new BillingAgent(llm, tools, systemPrompt(session, new Date('2026-11-20')));
  return { agent, llm, gw, mcp, trace, tools, confirmRequests };
}

/** The tool_result blocks the agent sent back in the last user message. */
export function lastToolResults(llm: ScriptedLlm): Anthropic.Beta.BetaToolResultBlockParam[] {
  const last = llm.requests[llm.requests.length - 1].messages;
  const msg = last[last.length - 1];
  return (msg.content as Anthropic.Beta.BetaToolResultBlockParam[]).filter((b) => b.type === 'tool_result');
}

export const parseResult = (r: Anthropic.Beta.BetaToolResultBlockParam) => JSON.parse(String(r.content));
