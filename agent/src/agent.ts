import type Anthropic from '@anthropic-ai/sdk';
import type { Session } from './gatewayClient';
import type { LlmClient } from './llm';
import type { ToolRegistry } from './tools';

const MAX_STEPS = 10;

export function systemPrompt(session: Session, today: Date): string {
  const who =
    session.role === 'ADMIN'
      ? 'an ADMIN operator, who may work on any subscriber number they give you'
      : `subscriber ${session.subscriberNo} (username ${session.username})`;
  return `You are the AI Billing Support Assistant of a mobile phone provider. You help with bills, usage, payments and billing policy.

You are talking to ${who}. Today is ${today.toISOString().slice(0, 10)}.

How to answer:
- Billing policy and pricing rules (how charges are calculated, free minutes, internet blocks, partial payments, due dates, late payments, disputes): call search_billing_documentation and base the answer on the returned passages. Cite the section, e.g. "(Billing Guide §3.2)". Do not answer policy questions from memory.
- Live data (a bill's total, paid amount, remaining balance, usage, payments): call the Billing REST API tools (get_bill, get_bill_details, pay_bill). Never invent or estimate usage or amounts; if the stored bill does not exist, say so instead of calculating one yourself.
- "Why is my bill X?" needs both: get_bill_details for the actual usage and charges, then search_billing_documentation for the rules that produce them. Show the short calculation.
- If the user does not say which month, ask, unless the context makes it clear.

Account safety:
- You only act for the account of this session. If the user asks about another subscriber number, explain that you can only access their own account; do not try to look it up.
- Payments: before calling pay_bill, state the subscriber, billing month and exact amount, and make sure the user has asked to pay that amount. The system then asks the user for a final yes/no itself. Report a payment as successful only when pay_bill returns paymentStatus SUCCESS, and include the transactionId and the new remaining balance. If the user declined, say that nothing was paid.
- You cannot open disputes or issue refunds; explain the process from the guide instead and never promise an adjustment.

Reply in the user's language (Turkish or English), briefly and clearly. Amounts are in USD.`;
}

export interface TurnResult {
  text: string;
  toolCalls: number;
  stopReason: string | null;
}

/**
 * Manual tool-calling loop over the Messages API: send history -> run every tool_use
 * block -> return all tool_results in one user message -> repeat until end_turn.
 * The full assistant content (including thinking blocks) is kept in history unchanged.
 */
export class BillingAgent {
  readonly history: Anthropic.Beta.BetaMessageParam[] = [];
  private turn = 0;

  constructor(
    private readonly llm: LlmClient,
    private readonly tools: ToolRegistry,
    private readonly system: string,
  ) {}

  async send(userText: string): Promise<TurnResult> {
    this.turn += 1;
    this.tools.setTurn(this.turn);
    this.history.push({ role: 'user', content: userText });
    let toolCalls = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await this.llm.create({
        system: this.system,
        messages: this.history,
        tools: this.tools.definitions(),
      });
      this.history.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') {
        return { text: 'Sorry, I can’t help with that request.', toolCalls, stopReason: 'refusal' };
      }
      if (response.stop_reason === 'pause_turn') continue;

      const toolUses = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        return { text: textOf(response), toolCalls, stopReason: response.stop_reason };
      }

      // Run the calls in order (a payment confirmation prompt must not interleave with others)
      // and send every result back in ONE user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        toolCalls += 1;
        const outcome = await this.tools.execute(use.name, use.input);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(outcome.result),
          is_error: !outcome.ok,
        });
      }
      this.history.push({ role: 'user', content: results });
    }

    return {
      text: 'I stopped because this request needed too many steps. Please ask in a simpler way.',
      toolCalls,
      stopReason: 'max_steps',
    };
  }
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
