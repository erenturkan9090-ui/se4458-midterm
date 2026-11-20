import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  isError: boolean;
  /** structuredContent when the server sends it, otherwise the text content. */
  data: unknown;
}

/** The part of the MCP client the agent needs; tests can pass a fake. */
export interface McpGateway {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

export class McpToolClient implements McpGateway {
  private constructor(private readonly client: Client) {}

  static async connect(url: string, apiKey?: string): Promise<McpToolClient> {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: apiKey ? { headers: { 'x-api-key': apiKey } } : undefined,
    });
    return McpToolClient.connectTransport(transport);
  }

  static async connectTransport(transport: Transport): Promise<McpToolClient> {
    const client = new Client({ name: 'billing-agent', version: '1.0.0' });
    await client.connect(transport);
    return new McpToolClient(client);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = Array.isArray(res.content)
      ? res.content
          .filter((c): c is { type: 'text'; text: string } => c?.type === 'text')
          .map((c) => c.text)
          .join('\n')
      : '';
    return { isError: Boolean(res.isError), data: res.structuredContent ?? text };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
