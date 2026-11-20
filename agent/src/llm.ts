import Anthropic from '@anthropic-ai/sdk';

export interface LlmRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

/** The one call the agent loop makes. Tests swap in a scripted fake, so they need no API key. */
export interface LlmClient {
  readonly model: string;
  create(req: LlmRequest): Promise<Anthropic.Beta.BetaMessage>;
}

/** Usage totals, used for the LLM cost estimate in the README. */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  cacheWriteTokens = 0;
  cacheReadTokens = 0;
  calls = 0;

  add(u: Anthropic.Beta.BetaUsage) {
    this.calls += 1;
    this.inputTokens += u.input_tokens;
    this.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    this.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    this.outputTokens += u.output_tokens;
  }

  /**
   * USD at Claude Opus 5.5 list prices per MTok: $4 input, $5 cache write (5-minute TTL),
   * $0.20 cache read, $20 output (thinking tokens are billed as output).
   */
  costUsd(): number {
    return (
      this.inputTokens * 4 + this.cacheWriteTokens * 5 + this.cacheReadTokens * 0.2 + this.outputTokens * 20
    ) / 1_000_000;
  }
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    readonly usage = new UsageMeter(),
    client?: Anthropic,
  ) {
    // Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.
    this.client = client ?? new Anthropic();
  }

  async create(req: LlmRequest): Promise<Anthropic.Beta.BetaMessage> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      // Thinking is adaptive by default on this model; effort controls depth and cost.
      output_config: { effort: this.effort },
      // If a safety classifier declines, the API retries on a fallback model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Caches the stable prefix (tools + system prompt) across the turns of a session.
      cache_control: { type: 'ephemeral' },
    });
    this.usage.add(response.usage);
    return response;
  }
}
