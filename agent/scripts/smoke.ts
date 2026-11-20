/**
 * Wiring check against the REAL services (gateway/API + MCP server) with a scripted
 * stand-in for Claude, so it runs without an Anthropic API key:
 *   npx tsx scripts/smoke.ts
 * It plays the three demo scenarios plus the two safety cases and prints the tool trace.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { BillingAgent, systemPrompt } from '../src/agent';
import { loadConfig } from '../src/config';
import { GatewayClient } from '../src/gatewayClient';
import type { LlmClient, LlmRequest } from '../src/llm';
import { McpToolClient } from '../src/mcpClient';
import { ToolRegistry } from '../src/tools';
import { formatTrace, TraceRecorder } from '../src/trace';

let n = 0;
const use = (name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id: `toolu_smoke_${++n}`, name, input }) as Anthropic.Beta.BetaToolUseBlock;
const msg = (content: unknown[], stop: string) =>
  ({ id: `m${++n}`, type: 'message', role: 'assistant', model: 'scripted', content, stop_reason: stop, usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as Anthropic.Beta.BetaMessage;
const done = (t: string) => msg([{ type: 'text', text: t }], 'end_turn');

class Scripted implements LlmClient {
  readonly model = 'scripted';
  constructor(private readonly steps: Anthropic.Beta.BetaMessage[]) {}
  async create(_req: LlmRequest) {
    const s = this.steps.shift();
    if (!s) throw new Error('script exhausted');
    return s;
  }
}

async function main() {
  const cfg = loadConfig();
  const gateway = new GatewayClient(cfg.gatewayBaseUrl, cfg.gatewaySubscriptionKey);
  const session = await gateway.login('5551000001', 'pass1234');
  const mcp = await McpToolClient.connect(cfg.mcpServerUrl, cfg.mcpApiKey);
  // SMOKE_TRACE_DIR also writes the trace as JSONL (used for docs/traces).
  const trace = new TraceRecorder({
    dir: process.env.SMOKE_TRACE_DIR,
    sessionId: process.env.SMOKE_TRACE_DIR ? 'azure-smoke' : undefined,
    echo: (e) => console.log(formatTrace(e)),
  });
  let answer = false;
  const tools = new ToolRegistry(session, gateway, mcp, async (req) => {
    console.log(`  [confirm] ${JSON.stringify(req)} -> ${answer ? 'yes' : 'no'}`);
    return answer;
  }, trace);
  await tools.init();

  const llm = new Scripted([
    msg([use('search_billing_documentation', { query: 'What is the cost of extra internet?' })], 'tool_use'),
    done('scenario 1 done'),
    msg([use('get_bill', { year: 2025, month: 10 })], 'tool_use'),
    done('scenario 2 done'),
    msg([use('get_bill_details', { year: 2025, month: 10, pageSize: 3 }), use('search_billing_documentation', { query: 'internet blocks and extra minutes pricing' })], 'tool_use'),
    done('scenario 3 done'),
    msg([use('get_bill_details', { subscriberNo: '5551000002', year: 2025, month: 10 })], 'tool_use'),
    done('other subscriber refused'),
    msg([use('pay_bill', { year: 2025, month: 10, amount: 20 })], 'tool_use'),
    done('payment declined'),
    msg([use('pay_bill', { year: 2025, month: 10, amount: 20 })], 'tool_use'),
    done('payment confirmed'),
  ]);
  const agent = new BillingAgent(llm, tools, systemPrompt(session, new Date()));

  const turns = [
    'What does extra internet cost?',
    'How much is my October 2025 bill?',
    'Why is my October 2025 bill that amount?',
    "Show subscriber 5551000002's bill",
    'Pay 20 dollars of my October bill (user will say no)',
    'Pay 20 dollars of my October bill (user will say yes)',
  ];
  for (const [i, t] of turns.entries()) {
    answer = i === 5;
    console.log(`\nUSER: ${t}`);
    const r = await agent.send(t);
    console.log(`AGENT: ${r.text}`);
  }
  await mcp.close();
  const failed = trace.entries.filter((e) => !e.ok).map((e) => e.tool);
  console.log(`\n${trace.entries.length} tool calls; errors (expected 2: refused + declined): ${failed.join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
