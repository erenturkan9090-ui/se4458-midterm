/**
 * Terminal chat with the billing assistant.
 *   npm start -w agent
 * Env: GEMINI_API_KEY (or ANTHROPIC_API_KEY), GATEWAY_BASE_URL, MCP_SERVER_URL (see .env.example).
 * Optional AGENT_USERNAME / AGENT_PASSWORD skip the login prompt.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { BillingAgent, systemPrompt } from './agent';
import fs from 'node:fs';
import path from 'node:path';
import { applyAzureEnv, loadConfig } from './config';
import { GatewayClient, GatewayError } from './gatewayClient';
import { GeminiLlm, isGeminiApiError } from './gemini';
import { AnthropicLlm } from './llm';
import { McpToolClient } from './mcpClient';
import { ToolRegistry, type PaymentRequest } from './tools';
import { formatTrace, TraceRecorder } from './trace';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const money = (n?: number) => (n === undefined ? '?' : `$${n.toFixed(2)}`);

async function main() {
  // --azure: use the deployed gateway (APIM) and MCP server from <repo>/.env.azure.
  if (process.argv.includes('--azure')) {
    const file = path.resolve(__dirname, '..', '..', '.env.azure');
    if (!fs.existsSync(file)) throw new Error(`--azure needs ${file} (run infra/azure/deploy.ps1 first)`);
    applyAzureEnv(file);
  }
  const config = loadConfig();
  const hasKey =
    config.provider === 'gemini'
      ? Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
      : Boolean(process.env.ANTHROPIC_API_KEY);
  if (!hasKey) {
    throw new Error(
      'No LLM API key in this terminal. Set it first, e.g.  $env:GEMINI_API_KEY = "..."  (or ANTHROPIC_API_KEY for Claude)',
    );
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log(bold('AI Billing Support Assistant'));
  const modelInfo = config.provider === 'claude' ? `${config.model} (effort ${config.effort})` : `${config.model} (Gemini)`;
  console.log(dim(`gateway: ${config.gatewayBaseUrl}\nmcp:     ${config.mcpServerUrl}\nmodel:   ${modelInfo}\n`));

  const gateway = new GatewayClient(config.gatewayBaseUrl, config.gatewaySubscriptionKey);
  const username = process.env.AGENT_USERNAME ?? (await rl.question('Username (subscriber no): ')).trim();
  const password = process.env.AGENT_PASSWORD ?? (await rl.question('Password: ')).trim();
  const session = await gateway.login(username, password);
  console.log(dim(`Logged in as ${session.username} (${session.role}${session.subscriberNo ? `, subscriber ${session.subscriberNo}` : ''})\n`));

  const mcp = await McpToolClient.connect(config.mcpServerUrl, config.mcpApiKey);
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 4);
  const trace = new TraceRecorder({
    dir: config.traceDir,
    sessionId,
    echo: (e) => console.log(dim(formatTrace(e))),
  });

  const confirmPayment = async (req: PaymentRequest): Promise<boolean> => {
    console.log(
      bold('\n  PAYMENT CONFIRMATION') +
        `\n  Subscriber: ${req.subscriberNo}` +
        `\n  Period:     ${String(req.month).padStart(2, '0')}/${req.year}` +
        `\n  Bill total: ${money(req.billTotal)}   remaining: ${money(req.remainingBalance)}` +
        `\n  Pay now:    ${bold(money(req.amount))}`,
    );
    const answer = (await rl.question('  Type "yes" to pay, anything else to cancel: ')).trim().toLowerCase();
    const ok = answer === 'yes' || answer === 'evet';
    console.log(dim(ok ? '  -> confirmed by user' : '  -> cancelled by user'));
    return ok;
  };

  const tools = new ToolRegistry(session, gateway, mcp, confirmPayment, trace);
  await tools.init();
  const llm = config.provider === 'gemini' ? new GeminiLlm(config.model) : new AnthropicLlm(config.model, config.effort);
  const agent = new BillingAgent(llm, tools, systemPrompt(session, new Date()));

  console.log(dim('Ask about your bill, usage, payments or billing rules. Type "exit" to quit.\n'));
  for (;;) {
    let line: string;
    try {
      line = (await rl.question(bold('You: '))).trim();
    } catch {
      break; // stdin closed
    }
    if (!line) continue;
    if (['exit', 'quit', 'çıkış', 'cikis'].includes(line.toLowerCase())) break;
    try {
      const result = await agent.send(line);
      console.log(`${bold('Assistant:')} ${result.text}\n`);
    } catch (err) {
      if (isGeminiApiError(err)) {
        if (err.status === 400 && /api key/i.test(err.message)) {
          console.error('Gemini API rejected the key. Set GEMINI_API_KEY.');
          break;
        }
        if (err.status === 401 || err.status === 403) {
          console.error('Gemini API rejected the credentials. Set GEMINI_API_KEY.');
          break;
        }
        if (err.status === 429) console.error('Gemini free-tier rate limit reached; wait a minute and try again.\n');
        else if (err.status === 503) {
          console.error('Gemini is overloaded right now (503). Ask again in a moment, or restart with another model, e.g. $env:GEMINI_MODEL = "gemini-3.5-flash-lite" (list them: npm run models -w agent).\n');
        }
        else console.error(`Gemini API error ${err.status}: ${err.message}\n`);
      } else if (err instanceof Anthropic.AuthenticationError) {
        console.error('Claude API rejected the credentials. Set ANTHROPIC_API_KEY.');
        break;
      } else if (err instanceof Anthropic.RateLimitError) {
        console.error('Claude API rate limit reached; wait a moment and try again.\n');
      } else if (err instanceof Anthropic.APIError) {
        console.error(`Claude API error ${err.status}: ${err.message}\n`);
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  const u = llm.usage;
  console.log(
    dim(
      `\nLLM usage: ${u.calls} calls, ${u.inputTokens} input + ${u.cacheWriteTokens} cache-write + ${u.cacheReadTokens} cache-read + ${u.outputTokens} output tokens ` +
        `≈ $${u.costUsd().toFixed(4)}${config.provider === 'gemini' ? ' (Gemini free tier)' : ''}. Trace: ${trace.file}`,
    ),
  );
  rl.close();
  await mcp.close();
}

main().catch((err) => {
  if (err instanceof GatewayError) console.error(`Gateway error ${err.status} ${err.code}: ${err.message}`);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
