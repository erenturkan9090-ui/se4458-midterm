import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai' with { 'resolution-mode': 'import' };
import { BillingAgent, systemPrompt } from '../src/agent';
import { applyAzureEnv, loadConfig } from '../src/config';
import { GeminiLlm, type GeminiModels } from '../src/gemini';
import { ToolRegistry } from '../src/tools';
import { TraceRecorder } from '../src/trace';
import { ALICE, fakeGateway, fakeMcp } from './helpers';

/** Fake Gemini models API: returns scripted responses and records every request. */
class FakeGemini implements GeminiModels {
  readonly requests: GenerateContentParameters[] = [];
  constructor(private readonly script: unknown[]) {}
  async generateContent(params: GenerateContentParameters) {
    this.requests.push(JSON.parse(JSON.stringify(params)));
    const next = this.script.shift();
    if (!next) throw new Error('FakeGemini ran out of responses');
    return next as GenerateContentResponse;
  }
}

const reply = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 60 },
  ...extra,
});

async function geminiAgent(script: unknown[]) {
  const fake = new FakeGemini(script);
  const gw = fakeGateway();
  const mcp = fakeMcp();
  const tools = new ToolRegistry(ALICE, gw.client, mcp, async () => false, new TraceRecorder());
  await tools.init();
  const llm = new GeminiLlm('gemini-test', undefined, fake);
  const agent = new BillingAgent(llm, tools, systemPrompt(ALICE, new Date('2026-11-20')));
  return { fake, gw, mcp, llm, agent };
}

describe('Gemini adapter', () => {
  it('sends the tools as function declarations and lets the model choose (AUTO)', async () => {
    const { fake, agent } = await geminiAgent([reply([{ text: 'Hello!' }])]);
    const r = await agent.send('hi');

    expect(r.text).toBe('Hello!');
    const cfg = fake.requests[0].config!;
    expect(cfg.systemInstruction).toContain('AI Billing Support Assistant');
    expect(cfg.toolConfig?.functionCallingConfig?.mode).toBe('AUTO');
    const decls = (cfg.tools![0] as { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] })
      .functionDeclarations;
    expect(decls.map((d) => d.name).sort()).toEqual(
      ['get_bill', 'get_bill_details', 'pay_bill', 'search_billing_documentation'].sort(),
    );
    // A subscriber session has no subscriberNo parameter on the REST tools.
    const getBill = decls.find((d) => d.name === 'get_bill')!;
    expect(JSON.stringify(getBill.parametersJsonSchema)).not.toContain('subscriberNo');
  });

  it('runs MCP and REST calls chosen by Gemini and returns the results as functionResponses', async () => {
    const { fake, gw, mcp, agent, llm } = await geminiAgent([
      reply([
        { functionCall: { id: 'fc-1', name: 'get_bill_details', args: { year: 2025, month: 10 } }, thoughtSignature: 'sig-A' },
        { functionCall: { id: 'fc-2', name: 'search_billing_documentation', args: { query: 'internet blocks' } } },
      ]),
      reply([{ text: 'Your bill is $70 (Billing Guide §3.2).' }]),
    ]);

    const r = await agent.send('Why is my October 2025 bill $70?');

    expect(r.text).toContain('§3.2');
    expect(r.toolCalls).toBe(2);
    expect(gw.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /billing/v1/bills/5551000001/detailed',
    ]);
    expect(mcp.calls[0]).toEqual({ name: 'search_billing_documentation', args: { query: 'internet blocks' } });

    const contents = fake.requests[1].contents as any[];
    // The model turn is replayed unchanged, thought signature included.
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { id: 'fc-1', name: 'get_bill_details', args: { year: 2025, month: 10 } }, thoughtSignature: 'sig-A' },
        { functionCall: { id: 'fc-2', name: 'search_billing_documentation', args: { query: 'internet blocks' } } },
      ],
    });
    // Both results go back in one user turn, matched by id and name.
    const responses = contents[2].parts.map((p: any) => p.functionResponse);
    expect(contents[2].role).toBe('user');
    expect(responses.map((f: any) => [f.id, f.name])).toEqual([
      ['fc-1', 'get_bill_details'],
      ['fc-2', 'search_billing_documentation'],
    ]);
    expect(responses[0].response.billTotal).toBe(70);
    expect(responses[1].response.matches[0].section).toBe('3.2');

    // Usage: thinking counts as output; the free tier costs nothing.
    expect(llm.usage.calls).toBe(2);
    expect(llm.usage.inputTokens).toBe(1800);
    expect(llm.usage.outputTokens).toBe(200);
    expect(llm.usage.costUsd()).toBe(0);
  });

  it('handles calls without an id and sends errors back under "error"', async () => {
    const { fake, gw, agent } = await geminiAgent([
      reply([{ functionCall: { name: 'get_bill_details', args: { subscriberNo: '5551000002', year: 2025, month: 10 } } }]),
      reply([{ text: 'I can only access your own account.' }]),
    ]);

    await agent.send("Show subscriber 5551000002's bill");

    expect(gw.calls).toHaveLength(0); // refused before any HTTP call
    const fr = (fake.requests[1].contents as any[])[2].parts[0].functionResponse;
    expect(fr.id).toBeUndefined(); // the made-up local id is not sent to Gemini
    expect(fr.name).toBe('get_bill_details');
    expect(fr.response.error.error.code).toBe('FORBIDDEN');
  });

  it('maps a blocked reply to a refusal and ignores thought text', async () => {
    const blocked = await geminiAgent([
      { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }], usageMetadata: {} },
    ]);
    expect((await blocked.agent.send('...')).stopReason).toBe('refusal');

    const thoughts = await geminiAgent([reply([{ text: 'internal reasoning', thought: true }, { text: 'Answer.' }])]);
    expect((await thoughts.agent.send('q')).text).toBe('Answer.');
  });
});

describe('applyAzureEnv', () => {
  it('copies only the gateway/MCP keys and keeps values already set', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'azenv-')), '.env.azure');
    fs.writeFileSync(file, 'GATEWAY_BASE_URL=https://apim/billing/v1\r\nJWT_SECRET=s3cret\r\nMCP_API_KEY=k\r\nMCP_SERVER_URL=https://mcp/mcp\n');
    const env: NodeJS.ProcessEnv = { MCP_SERVER_URL: 'http://already-set' };
    expect(applyAzureEnv(file, env).sort()).toEqual(['GATEWAY_BASE_URL', 'MCP_API_KEY']);
    expect(env.MCP_SERVER_URL).toBe('http://already-set');
    expect(env.JWT_SECRET).toBeUndefined();
  });
});

describe('LLM provider selection', () => {
  const base = { GATEWAY_BASE_URL: 'http://gw/billing/v1' };
  it('uses Gemini when only a Gemini key is set', () => {
    const c = loadConfig({ ...base, GEMINI_API_KEY: 'x' });
    expect([c.provider, c.model]).toEqual(['gemini', 'gemini-3.5-flash']);
  });
  it('uses Claude when an Anthropic key is set and no provider is requested', () => {
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'x', GEMINI_API_KEY: 'y' }).provider).toBe('claude');
  });
  it('honours LLM_PROVIDER and rejects unknown values', () => {
    expect(loadConfig({ ...base, LLM_PROVIDER: 'gemini', GEMINI_MODEL: 'gemini-x' }).model).toBe('gemini-x');
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'gpt' })).toThrow(/LLM_PROVIDER/);
  });
});
