/** Protocol-level tests: a real MCP client talks to the server (in memory and over HTTP). */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BillingDocs } from '../src/billingDocs';
import { createMcpServer, TOOL_NAME } from '../src/mcpServer';
import { createApp } from '../src/app';

const docs = BillingDocs.fromFile();
const quiet = () => undefined;

async function inMemoryClient() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(docs, quiet);
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientT);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

describe('MCP tool over the protocol', () => {
  it('lists search_billing_documentation with a query input schema', async () => {
    const { client, close } = await inMemoryClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === TOOL_NAME)!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['query']);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['query', 'maxResults']);
    expect(tool.annotations?.readOnlyHint).toBe(true);
    await close();
  });

  it('success: returns cited passages as text and structured content', async () => {
    const { client, close } = await inMemoryClient();
    const res = await client.callTool({ name: TOOL_NAME, arguments: { query: 'extra internet cost' } });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { documentId: string; matches: { section: string }[] };
    expect(structured.documentId).toBe('MOB-BILLING-2026-01');
    expect(structured.matches.map((m) => m.section)).toContain('3.2');
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text).matches[0].section).toBeDefined();
    await close();
  });

  it('failure: rejects an empty query with a tool error', async () => {
    const { client, close } = await inMemoryClient();
    const res = await client.callTool({ name: TOOL_NAME, arguments: { query: ' ' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/at least 2 characters/);
    await close();
  });

  it('failure: unknown tool name returns an error', async () => {
    const { client, close } = await inMemoryClient();
    const res = await client.callTool({ name: 'delete_everything', arguments: {} }).catch((e) => e);
    expect(JSON.stringify(res instanceof Error ? res.message : res)).toMatch(/not found/i);
    await close();
  });
});

describe('HTTP transport (/mcp)', () => {
  let server: Server;
  let url: URL;

  beforeAll(async () => {
    const app = createApp({ docs, apiKey: 'test-key', logger: quiet });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('success: a real Streamable HTTP client can call the tool', async () => {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { 'x-api-key': 'test-key' } },
    });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);
    const res = await client.callTool({
      name: TOOL_NAME,
      arguments: { query: 'Can I pay part of my bill?', maxResults: 2 },
    });
    const structured = res.structuredContent as { matches: { section: string }[] };
    expect(structured.matches).toHaveLength(2);
    expect(structured.matches.map((m) => m.section)).toContain('8.3');
    await client.close();
  });

  it('failure: 401 without the API key', async () => {
    const res = await request(server)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/x-api-key/);
  });

  it('failure: GET /mcp is 405 in stateless mode', async () => {
    const res = await request(server).get('/mcp').set('x-api-key', 'test-key');
    expect(res.status).toBe(405);
  });

  it('health reports the indexed document', async () => {
    const res = await request(server).get('/health');
    expect(res.body).toEqual({ status: 'ok', document: 'MOB-BILLING-2026-01', chunks: 26 });
  });
});
