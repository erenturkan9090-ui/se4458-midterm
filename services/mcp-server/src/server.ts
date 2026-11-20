import { createApp } from './app';
import { BillingDocs } from './billingDocs';

const port = Number(process.env.PORT ?? 4000);
const docPath = process.env.BILLING_GUIDE_PATH;

// Index the guide once at start-up; every tool call reuses it.
const started = Date.now();
const docs = docPath ? BillingDocs.fromFile(docPath) : BillingDocs.fromFile();
console.log(
  `Indexed ${docs.chunks.length} sections of ${docs.documentId} in ${Date.now() - started} ms`,
);

const app = createApp({ docs, apiKey: process.env.MCP_API_KEY || undefined });
app.listen(port, () => {
  console.log(`MCP server listening on http://localhost:${port}/mcp`);
});
