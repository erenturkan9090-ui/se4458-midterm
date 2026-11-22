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

/** USD per million tokens. */
export interface TokenPrices {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Claude Opus 5.5 list prices; cache write is the 5-minute TTL; thinking is billed as output. */
export const CLAUDE_OPUS_5_5_PRICES: TokenPrices = { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 };
/** Gemini API free tier: no charge (rate-limited). */
export const GEMINI_FREE_TIER_PRICES: TokenPrices = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

/** Usage totals, used for the LLM cost figures in the README. */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  cacheWriteTokens = 0;
  cacheReadTokens = 0;
  calls = 0;

  constructor(readonly prices: TokenPrices = CLAUDE_OPUS_5_5_PRICES) {}

  add(u: { input: number; output: number; cacheWrite?: number; cacheRead?: number }) {
    this.calls += 1;
    this.inputTokens += u.input;
    this.cacheWriteTokens += u.cacheWrite ?? 0;
    this.cacheReadTokens += u.cacheRead ?? 0;
    this.outputTokens += u.output;
  }

  costUsd(): number {
    const p = this.prices;
    return (
      this.inputTokens * p.input +
      this.cacheWriteTokens * p.cacheWrite +
      this.cacheReadTokens * p.cacheRead +
      this.outputTokens * p.output
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
    const u = response.usage;
    this.usage.add({
      input: u.input_tokens,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens,
    });
    return response;
  }
}
