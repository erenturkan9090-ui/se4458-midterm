/**
 * Agent tests with a scripted LLM: no API key, network, cloud or MCP server needed.
 * The script plays the model's side; the tests check what the agent code does with it.
 */
import { buildAgent, lastToolResults, message, parseResult, text, toolUse, ALICE } from './helpers';
import { decodeJwtPayload, GatewayClient } from '../src/gatewayClient';

describe('scenario 1: MCP only (policy question)', () => {
  it('calls search_billing_documentation on the MCP server and answers', async () => {
    const { agent, llm, mcp, trace, gw } = await buildAgent([
      message([toolUse('search_billing_documentation', { query: 'extra internet cost' })], 'tool_use'),
      message([text('Each extra 10 GB costs $10 (Billing Guide §3.2).')], 'end_turn'),
    ]);
    const r = await agent.send('What does extra internet cost?');
    expect(r.text).toContain('§3.2');
    expect(mcp.calls).toEqual([{ name: 'search_billing_documentation', args: { query: 'extra internet cost' } }]);
    expect(gw.calls).toHaveLength(0);
    expect(parseResult(lastToolResults(llm)[0]).matches[0].section).toBe('3.2');
    expect(trace.entries.map((e) => [e.source, e.tool, e.ok])).toEqual([['MCP', 'search_billing_documentation', true]]);
  });
});

describe('scenario 2: REST only (live bill)', () => {
  it('calls Query Bill through the gateway for the logged-in subscriber', async () => {
    const { agent, gw, trace } = await buildAgent([
      message([toolUse('get_bill', { year: 2025, month: 10 })], 'tool_use'),
      message([text('Your October 2025 bill is $70, unpaid.')], 'end_turn'),
    ]);
    await agent.send('How much is my October 2025 bill?');
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0].url).toBe('http://gw.test/billing/v1/bills/5551000001?year=2025&month=10');
    expect(gw.calls[0].headers['Ocp-Apim-Subscription-Key']).toBe('sub-key');
    expect(trace.entries[0]).toMatchObject({
      source: 'REST',
      tool: 'get_bill',
      ok: true,
      http: ['GET /bills/5551000001?year=2025&month=10 -> 200'],
    });
  });
});

describe('scenario 3: MCP + REST combined', () => {
  it('runs parallel tool calls and returns all results in one user message', async () => {
    const { agent, llm, gw, mcp } = await buildAgent([
      message(
        [
          toolUse('get_bill_details', { year: 2025, month: 10 }),
          toolUse('search_billing_documentation', { query: 'internet blocks pricing' }),
        ],
        'tool_use',
      ),
      message([text('25 GB -> $50 + one extra block $10; 1,500 min -> $10. Total $70.')], 'end_turn'),
    ]);
    const r = await agent.send('Why is my October bill $70?');
    expect(r.toolCalls).toBe(2);
    expect(gw.calls[0].headers.Authorization).toBe('Bearer alice-token');
    expect(mcp.calls).toHaveLength(1);
    const results = lastToolResults(llm);
    expect(results).toHaveLength(2);
    expect(parseResult(results[0]).charges.total).toBe(70);
  });
});

describe('payments require explicit human confirmation', () => {
  it('declined: no payment request is sent and the model is told nothing was paid', async () => {
    const { agent, llm, gw, confirmRequests } = await buildAgent(
      [
        message([toolUse('pay_bill', { year: 2025, month: 10, amount: 70 })], 'tool_use'),
        message([text('OK, nothing was paid.')], 'end_turn'),
      ],
      { confirm: false },
    );
    await agent.send('Pay my October bill');
    expect(confirmRequests).toEqual([
      { subscriberNo: '5551000001', year: 2025, month: 10, amount: 70, billTotal: 70, remainingBalance: 70 },
    ]);
    expect(gw.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const r = lastToolResults(llm)[0];
    expect(r.is_error).toBe(true);
    expect(parseResult(r).paymentStatus).toBe('NOT_SUBMITTED');
  });

  it('confirmed: pays once with a bearer token and an agent transactionId', async () => {
    const { agent, llm, gw } = await buildAgent(
      [
        message([toolUse('pay_bill', { year: 2025, month: 10, amount: 30.5 })], 'tool_use'),
        message([text('Paid $30.50. Remaining $39.50.')], 'end_turn'),
      ],
      { confirm: true },
    );
    await agent.send('Pay 30.50 for October 2025');
    const posts = gw.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].headers.Authorization).toBe('Bearer alice-token');
    expect(posts[0].body).toMatchObject({ subscriberNo: '5551000001', year: 2025, month: 10, amount: 30.5 });
    expect(posts[0].body.transactionId).toMatch(/^agent-[0-9a-f-]{36}$/);
    const result = parseResult(lastToolResults(llm)[0]);
    expect(result).toMatchObject({ paymentStatus: 'SUCCESS', remainingBalance: 39.5, status: 'PARTIALLY_PAID' });
  });

  it('network failure: retries with the SAME transactionId and does not pay twice', async () => {
    const { agent, llm, gw } = await buildAgent(
      [
        message([toolUse('pay_bill', { year: 2025, month: 10, amount: 70 })], 'tool_use'),
        message([text('Paid.')], 'end_turn'),
      ],
      { confirm: true, failNetworkOnce: true },
    );
    await agent.send('Pay my October bill');
    const posts = gw.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].body.transactionId).toBe(posts[1].body.transactionId);
    expect(parseResult(lastToolResults(llm)[0]).paymentStatus).toBe('SUCCESS');
  });

  it('does not ask for confirmation when the bill does not exist', async () => {
    const { agent, llm, confirmRequests } = await buildAgent(
      [
        message([toolUse('pay_bill', { year: 2024, month: 1, amount: 10 })], 'tool_use'),
        message([text('There is no bill for January 2024.')], 'end_turn'),
      ],
      { confirm: true },
    );
    await agent.send('Pay 10 for January 2024');
    expect(confirmRequests).toHaveLength(0);
    expect(parseResult(lastToolResults(llm)[0]).error).toMatchObject({ httpStatus: 404, code: 'NOT_FOUND' });
  });
});

describe('another subscriber number in the prompt', () => {
  it('subscriber sessions expose no subscriberNo parameter to the model', async () => {
    const { tools } = await buildAgent([]);
    for (const t of tools.definitions().filter((d) => d.name !== 'search_billing_documentation')) {
      expect(Object.keys((t.input_schema as any).properties)).not.toContain('subscriberNo');
    }
  });

  it('refuses a subscriberNo the model slips in, without calling the gateway', async () => {
    const { agent, llm, gw } = await buildAgent([
      message([toolUse('get_bill_details', { subscriberNo: '5551000002', year: 2025, month: 10 })], 'tool_use'),
      message([text('I can only access your own account.')], 'end_turn'),
    ]);
    await agent.send("Show me 5551000002's detailed bill");
    expect(gw.calls).toHaveLength(0);
    const r = lastToolResults(llm)[0];
    expect(r.is_error).toBe(true);
    expect(parseResult(r).error).toMatchObject({ httpStatus: 403, code: 'FORBIDDEN' });
  });
});

describe('failure handling', () => {
  it('invalid tool input (month 13) is rejected before any HTTP call', async () => {
    const { agent, llm, gw } = await buildAgent([
      message([toolUse('get_bill', { year: 2025, month: 13 })], 'tool_use'),
      message([text('Which month do you mean?')], 'end_turn'),
    ]);
    await agent.send('bill for month 13');
    expect(gw.calls).toHaveLength(0);
    expect(parseResult(lastToolResults(llm)[0]).error.code).toBe('INVALID_TOOL_INPUT');
  });

  it('a 404 from the API reaches the model as an is_error tool_result', async () => {
    const { agent, llm } = await buildAgent([
      message([toolUse('get_bill', { year: 2025, month: 1 })], 'tool_use'),
      message([text('No bill has been calculated for January 2025.')], 'end_turn'),
    ]);
    const r = await agent.send('January 2025 bill?');
    expect(r.text).toMatch(/No bill/);
    const res = lastToolResults(llm)[0];
    expect(res.is_error).toBe(true);
    expect(parseResult(res).error.code).toBe('NOT_FOUND');
  });

  it('a refusal stop reason ends the turn with a safe message', async () => {
    const { agent } = await buildAgent([message([], 'refusal')]);
    const r = await agent.send('something disallowed');
    expect(r.stopReason).toBe('refusal');
  });

  it('keeps the full assistant content in history across turns', async () => {
    const { agent, llm } = await buildAgent([
      message([text('Hi!')], 'end_turn'),
      message([text('Sure.')], 'end_turn'),
    ]);
    await agent.send('hello');
    await agent.send('again');
    expect(llm.requests[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('gateway client', () => {
  it('login reads role and subscriber number from the JWT', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: '5551000001', role: 'SUBSCRIBER', sno: '5551000001' })).toString('base64url');
    const token = `h.${payload}.s`;
    const client = new GatewayClient('http://gw.test/billing/v1', undefined, async () =>
      new Response(JSON.stringify({ accessToken: token }), { status: 200 }),
    );
    await expect(client.login('5551000001', 'pw')).resolves.toEqual({ ...ALICE, accessToken: token });
  });

  it('login failure surfaces the API error code', async () => {
    const client = new GatewayClient('http://gw.test/billing/v1', undefined, async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid username or password' } }), { status: 401 }),
    );
    await expect(client.login('x', 'y')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('decodeJwtPayload rejects a malformed token', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow('Malformed');
  });
});
