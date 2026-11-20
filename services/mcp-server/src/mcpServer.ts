import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BillingDocs } from './billingDocs';

export const TOOL_NAME = 'search_billing_documentation';

const TOOL_DESCRIPTION =
  'Search the Mobile Provider Billing Guide (policy document MOB-BILLING-2026-01). ' +
  'Use it for billing POLICY questions: phone and internet pricing rules, how bills are calculated, ' +
  'partial payments, payment confirmation, due dates, late payments, service restriction and disputes. ' +
  'Returns the most relevant passages with section ID, heading and text so the answer can cite them ' +
  '(e.g. "see Section 3.2"). It does NOT contain any subscriber\'s live usage, bill totals or payment ' +
  'status; use the Billing REST API for those.';

export type ToolLogger = (entry: { tool: string; query: string; sections: string[]; ms: number }) => void;

const defaultLogger: ToolLogger = (entry) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'tool_call', ...entry }));

/**
 * Builds an MCP server exposing the documentation search tool.
 * `docs` is the already-built index; creating a server does not re-index anything.
 */
export function createMcpServer(docs: BillingDocs, log: ToolLogger = defaultLogger): McpServer {
  const server = new McpServer({ name: 'billing-docs', version: '1.0.0' });

  server.registerTool(
    TOOL_NAME,
    {
      title: 'Search billing documentation',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(2, 'query must be at least 2 characters')
          .max(500)
          .describe('Natural-language question or keywords, e.g. "cost of extra internet"'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('How many passages to return (default 3)'),
      },
      outputSchema: {
        document: z.string(),
        documentId: z.string(),
        query: z.string(),
        matches: z.array(
          z.object({ section: z.string(), heading: z.string(), text: z.string(), score: z.number() }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, maxResults }) => {
      const started = Date.now();
      const result = docs.search(query, maxResults ?? 3);
      log({
        tool: TOOL_NAME,
        query,
        sections: result.matches.map((m) => m.section),
        ms: Date.now() - started,
      });
      const payload =
        result.matches.length > 0
          ? result
          : { ...result, note: 'No passage in the billing guide matches this query.' };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: { ...result },
      };
    },
  );

  return server;
}
