export interface AgentConfig {
  /** Base URL of the API Gateway, including the version prefix, e.g. https://<apim>.azure-api.net/billing/v1 */
  gatewayBaseUrl: string;
  /** Optional Azure APIM subscription key, sent as Ocp-Apim-Subscription-Key. */
  gatewaySubscriptionKey?: string;
  mcpServerUrl: string;
  mcpApiKey?: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  traceDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    gatewayBaseUrl: (env.GATEWAY_BASE_URL ?? 'http://localhost:8000/billing/v1').replace(/\/+$/, ''),
    gatewaySubscriptionKey: env.GATEWAY_SUBSCRIPTION_KEY || undefined,
    mcpServerUrl: env.MCP_SERVER_URL ?? 'http://localhost:4000/mcp',
    mcpApiKey: env.MCP_API_KEY || undefined,
    model: env.CLAUDE_MODEL ?? 'claude-opus-5-5',
    effort: (env.CLAUDE_EFFORT as AgentConfig['effort']) ?? 'medium',
    traceDir: env.TRACE_DIR ?? 'traces',
  };
}
