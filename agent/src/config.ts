import fs from 'node:fs';

export type LlmProvider = 'claude' | 'gemini';

/** Keys the agent takes from .env.azure (written by infra/azure/deploy.ps1). */
const AZURE_KEYS = ['GATEWAY_BASE_URL', 'GATEWAY_SUBSCRIPTION_KEY', 'MCP_SERVER_URL', 'MCP_API_KEY'];

/**
 * Copies the gateway/MCP URLs and keys from an env file into `env`, without overwriting
 * values that are already set. Returns the keys it set.
 */
export function applyAzureEnv(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const set: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && AZURE_KEYS.includes(m[1]) && !env[m[1]] && m[2]) {
      env[m[1]] = m[2];
      set.push(m[1]);
    }
  }
  return set;
}

export interface AgentConfig {
  /** Base URL of the API Gateway, including the version prefix, e.g. https://<apim>.azure-api.net/billing/v1 */
  gatewayBaseUrl: string;
  /** Optional Azure APIM subscription key, sent as Ocp-Apim-Subscription-Key. */
  gatewaySubscriptionKey?: string;
  mcpServerUrl: string;
  mcpApiKey?: string;
  /** Which LLM drives the agent. Both use real tool/function calling through the same loop. */
  provider: LlmProvider;
  model: string;
  /** Claude only: reasoning effort. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  traceDir: string;
}

/**
 * LLM_PROVIDER picks the model provider. When it is not set, Gemini is used if only
 * GEMINI_API_KEY / GOOGLE_API_KEY is present, otherwise Claude.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const hasGeminiKey = Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  const requested = env.LLM_PROVIDER?.trim().toLowerCase();
  if (requested && requested !== 'claude' && requested !== 'gemini') {
    throw new Error(`LLM_PROVIDER must be "claude" or "gemini", got "${env.LLM_PROVIDER}"`);
  }
  const provider: LlmProvider =
    (requested as LlmProvider | undefined) ?? (hasGeminiKey && !env.ANTHROPIC_API_KEY ? 'gemini' : 'claude');
  return {
    gatewayBaseUrl: (env.GATEWAY_BASE_URL ?? 'http://localhost:8000/billing/v1').replace(/\/+$/, ''),
    gatewaySubscriptionKey: env.GATEWAY_SUBSCRIPTION_KEY || undefined,
    mcpServerUrl: env.MCP_SERVER_URL ?? 'http://localhost:4000/mcp',
    mcpApiKey: env.MCP_API_KEY || undefined,
    provider,
    model:
      provider === 'gemini'
        // gemini-3.5-flash: answered reliably on the free tier in the live test, while the
        // newest Flash models (gemini-flash-latest, gemini-3.8-flash) returned 503 "high demand".
        ? (env.GEMINI_MODEL ?? 'gemini-3.5-flash')
        : (env.CLAUDE_MODEL ?? 'claude-opus-5-5'),
    effort: (env.CLAUDE_EFFORT as AgentConfig['effort']) ?? 'medium',
    traceDir: env.TRACE_DIR ?? 'traces',
  };
}
