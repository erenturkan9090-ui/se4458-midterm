import type Anthropic from '@anthropic-ai/sdk';
// @google/genai ships ESM type declarations but also a CommonJS build (exports "require").
// This package compiles to CommonJS, so types are imported type-only and the runtime
// values are loaded with require().
import type {
  ApiError as ApiErrorType,
  Content,
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI as GoogleGenAIType,
  Part,
} from '@google/genai' with { 'resolution-mode': 'import' };
import { GEMINI_FREE_TIER_PRICES, UsageMeter, type LlmClient, type LlmRequest } from './llm';

const genai = require('@google/genai') as {
  GoogleGenAI: typeof GoogleGenAIType;
  ApiError: typeof ApiErrorType;
};

/** True for an HTTP error returned by the Gemini API. */
export function isGeminiApiError(err: unknown): err is ApiErrorType {
  return err instanceof genai.ApiError;
}

/** The one SDK call this adapter makes; tests pass a fake. */
export interface GeminiModels {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
}

/** Prefix for tool-call ids we make up when Gemini returns a call without an id. */
const LOCAL_ID = 'gemini-call-';

/** Finish reasons meaning the reply was blocked (FinishReason enum values). */
const BLOCKED: ReadonlySet<string> = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

/**
 * Gemini behind the same LlmClient interface as Claude, so the agent loop, tools and tests
 * stay unchanged. Each call translates the history (Messages API shape) into Gemini
 * `contents` and the reply back into a Messages API message:
 *   - tool definitions -> functionDeclarations (parametersJsonSchema = the tool's JSON Schema)
 *   - tool_use <-> functionCall, tool_result -> functionResponse
 *   - the model's own Content is replayed unchanged for its turns, so thought signatures
 *     (required by Gemini's thinking models for multi-step function calling) are kept.
 */
export class GeminiLlm implements LlmClient {
  private readonly models: GeminiModels;
  /** Original Gemini Content for each assistant message we returned (keyed by its content array). */
  private readonly raw = new WeakMap<object, Content>();
  private localIds = 0;

  constructor(
    readonly model: string,
    readonly usage = new UsageMeter(GEMINI_FREE_TIER_PRICES),
    models?: GeminiModels,
  ) {
    // Reads GEMINI_API_KEY (or GOOGLE_API_KEY) from the environment.
    // The SDK default retries 5 times with up to 60 s backoff, which looks like a hang in a
    // chat. Here: up to 3 attempts 2-8 s apart (rides out short 503 "high demand" spikes and
    // 429s), 60 s per attempt, so a persistent error reaches the user within seconds.
    this.models =
      models ??
      new genai.GoogleGenAI({
        httpOptions: { timeout: 60_000, retryOptions: { attempts: 3, initialDelay: 2, maxDelay: 8 } },
      }).models;
  }

  async create(req: LlmRequest): Promise<Anthropic.Beta.BetaMessage> {
    const response = await this.models.generateContent({
      model: this.model,
      contents: this.toContents(req.messages),
      config: {
        systemInstruction: req.system,
        tools: [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.input_schema,
            })),
          },
        ],
        // The model decides whether to call a tool (no forced or keyword routing).
        toolConfig: { functionCallingConfig: { mode: 'AUTO' as never } },
        maxOutputTokens: 8192,
      },
    });

    const u = response.usageMetadata;
    const cached = u?.cachedContentTokenCount ?? 0;
    this.usage.add({
      input: Math.max(0, (u?.promptTokenCount ?? 0) - cached),
      cacheRead: cached,
      output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    });

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const content: Anthropic.Beta.BetaContentBlock[] = [];
    for (const part of parts) {
      if (part.functionCall) {
        content.push({
          type: 'tool_use',
          id: part.functionCall.id || `${LOCAL_ID}${++this.localIds}`,
          name: part.functionCall.name ?? '',
          input: part.functionCall.args ?? {},
        } as Anthropic.Beta.BetaToolUseBlock);
      } else if (part.text && !part.thought) {
        content.push({ type: 'text', text: part.text, citations: null } as Anthropic.Beta.BetaTextBlock);
      }
    }
    if (candidate?.content) this.raw.set(content, candidate.content);

    const finish = candidate?.finishReason;
    let stop: Anthropic.Beta.BetaStopReason;
    if (response.promptFeedback?.blockReason || (finish && BLOCKED.has(finish))) stop = 'refusal';
    else if (content.some((b) => b.type === 'tool_use')) stop = 'tool_use';
    else if (finish === 'MAX_TOKENS') stop = 'max_tokens';
    else stop = 'end_turn';

    return {
      id: response.responseId ?? `gemini-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: response.modelVersion ?? this.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: {
        input_tokens: u?.promptTokenCount ?? 0,
        output_tokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      },
    } as unknown as Anthropic.Beta.BetaMessage;
  }

  /** Messages API history -> Gemini contents. */
  toContents(messages: Anthropic.Beta.BetaMessageParam[]): Content[] {
    const toolNames = new Map<string, string>();
    const contents: Content[] = [];
    for (const m of messages) {
      if (typeof m.content === 'string') {
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
        continue;
      }
      const blocks = (m.content ?? []) as Anthropic.Beta.BetaContentBlockParam[];
      if (m.role === 'assistant') {
        for (const b of blocks) if (b.type === 'tool_use') toolNames.set(b.id, b.name);
        contents.push(this.raw.get(m.content) ?? { role: 'model', parts: blocks.flatMap(assistantPart) });
        continue;
      }
      const parts: Part[] = [];
      for (const b of blocks) {
        if (b.type === 'text') parts.push({ text: b.text });
        else if (b.type === 'tool_result') {
          const id = b.tool_use_id;
          parts.push({
            functionResponse: {
              ...(id.startsWith(LOCAL_ID) ? {} : { id }),
              name: toolNames.get(id) ?? 'unknown_tool',
              response: toolResponse(b),
            },
          });
        }
      }
      contents.push({ role: 'user', parts });
    }
    return contents;
  }
}

function assistantPart(b: Anthropic.Beta.BetaContentBlockParam): Part[] {
  if (b.type === 'text') return [{ text: b.text }];
  if (b.type === 'tool_use') {
    return [{
      functionCall: {
        ...(b.id.startsWith(LOCAL_ID) ? {} : { id: b.id }),
        name: b.name,
        args: (b.input ?? {}) as Record<string, unknown>,
      },
    }];
  }
  return [];
}

/** A functionResponse.response must be an object; errors go under "error" as Gemini recommends. */
function toolResponse(b: Anthropic.Beta.BetaToolResultBlockParam): Record<string, unknown> {
  const raw = typeof b.content === 'string'
    ? b.content
    : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // plain text result
  }
  if (b.is_error) return { error: value };
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { output: value };
}
