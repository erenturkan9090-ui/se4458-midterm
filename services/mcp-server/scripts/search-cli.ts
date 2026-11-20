/** Quick manual check of the index: npm run search -w mcp-server -- "extra internet cost" */
import { BillingDocs } from '../src/billingDocs';

const docs = BillingDocs.fromFile();
const query = process.argv.slice(2).join(' ') || 'What is the cost of extra internet?';
console.log(`${docs.chunks.length} chunks indexed`);
console.log(JSON.stringify(docs.search(query), null, 2));
