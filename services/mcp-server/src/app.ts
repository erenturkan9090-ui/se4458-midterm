import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BillingDocs } from './billingDocs';
import { createMcpServer, type ToolLogger } from './mcpServer';

export interface AppOptions {
  docs: BillingDocs;
  /** When set, every /mcp request must send it in the `x-api-key` header. */
  apiKey?: string;
  logger?: ToolLogger;
}

const jsonRpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Streamable HTTP MCP endpoint in stateless mode: each POST /mcp gets a fresh
 * McpServer + transport (cheap), all sharing the index that was built at start-up.
 * Stateless mode fits App Service / Container Apps where requests may hit any instance.
 */
export function createApp({ docs, apiKey, logger }: AppOptions) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', document: docs.documentId, chunks: docs.chunks.length });
  });

  const requireKey = (req: Request, res: Response, next: NextFunction) => {
    if (apiKey && req.header('x-api-key') !== apiKey) {
      jsonRpcError(res, 401, -32001, 'Unauthorized: missing or invalid x-api-key');
      return;
    }
    next();
  };

  app.post('/mcp', requireKey, async (req, res) => {
    const server = createMcpServer(docs, logger);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed', err);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  // Stateless server: no SSE stream to resume and no session to delete.
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed. Use POST.');
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  return app;
}
