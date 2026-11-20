# SE4458 Midterm — AI Billing Support Assistant (Group 2)

A conversational assistant for mobile subscribers. It answers questions about billing rules, current bills, detailed usage and payments. An LLM (Claude) picks which tools to use, and the agent runs them:

- **MCP Server**: `search_billing_documentation(query)` searches the indexed `Mobile_Provider_Billing_Guide.md`.
- **Billing REST API**, reached through the **API Gateway**: Add Usage, Calculate Bill, Query Bill, Query Bill Detailed, Pay Bill.

## Architecture

```
User ─► AI Agent ◄──► LLM (Claude, tool calling)
           │
           ├─► MCP Client ─► MCP Server ─► indexed billing guide
           │
           └─► API Gateway (Azure APIM) ─► Billing REST API ─► PostgreSQL
```

## Repository layout

| Path | Contents |
|---|---|
| `services/billing-api` | Express + TypeScript REST API, Swagger, JWT, unit tests (Jest) |
| `services/mcp-server` | MCP SDK server, document chunking + full-text index |
| `agent` | CLI chat agent: Claude tool calling, MCP client, gateway client |
| `gateway` | API Gateway route definitions / policies |
| `docs` | ER diagram, screenshots, tool traces |

## Tech decisions
- **Language:** Node.js + TypeScript
- **Database:** PostgreSQL (Azure Database for PostgreSQL)
- **Gateway:** Azure API Management
- **Cloud:** Azure (App Service / Container Apps)
- **LLM:** Claude API

## Billing API (`services/billing-api`)

### Endpoints (`/api/v1`)

| Operation | Method & route | Auth | Paging |
|---|---|---|---|
| Login | `POST /auth/login` | – | – |
| Add Usage | `POST /usage` | JWT | – |
| Calculate Bill | `POST /bills/calculate` | JWT | – |
| Query Bill | `GET /bills/{subscriberNo}?year&month` | **none** (per spec) | – |
| Query Bill Detailed | `GET /bills/{subscriberNo}/detailed?year&month&page&pageSize` | JWT | yes |
| Pay Bill | `POST /payments` | JWT | – |

The Swagger UI is served at `/docs` and the OpenAPI JSON at `/openapi.json`. The source spec is `services/billing-api/src/openapi.yaml`.

### Run locally (no Docker needed)

```bash
npm install
# Terminal 1 - local PostgreSQL 18 (embedded) + schema + demo data, keep it running
npm run db:local -w billing-api
# Terminal 2 - API on http://localhost:3000 (Swagger: /docs)
DATABASE_URL=postgresql://billing:billing@localhost:5432/billing JWT_SECRET=dev-secret npm run dev -w billing-api
```

The first run downloads the PostgreSQL binaries into `~/.se4458-pg` and stores data in `~/.se4458-pgdata`. On Windows, `initdb` can't run under a non-ASCII path like `Masaüstü` or with a Turkish system locale, so both folders sit outside the repo and the cluster uses the `C` locale.

### Demo accounts

| Username | Password | Role |
|---|---|---|
| `5551000001` | `pass1234` | SUBSCRIBER (Oct 2025 bill: 1,500 min + 25,000 MB = **$70**) |
| `5551000002` | `pass1234` | SUBSCRIBER (Oct 2025 bill: 3,200 min + 41,500 MB = **$110**) |
| `admin` | `admin123` | ADMIN |

### Unit tests

```bash
npm test -w billing-api
```

There are 53 tests (Jest + Supertest) covering the business rules and every endpoint, with success and failure/edge cases for each. They run against an in-memory repository, so they need no database, cloud or LLM.

## MCP Server (`services/mcp-server`)

The server exposes one tool, `search_billing_documentation`, over MCP Streamable HTTP at `POST /mcp`. It searches the policy document `data/Mobile_Provider_Billing_Guide.md` (MOB-BILLING-2026-01).

### Tool schema

| | |
|---|---|
| Name | `search_billing_documentation` |
| Input | `query: string` (required, 2–500 chars), `maxResults?: integer` (1–5, default 3) |
| Output | `{ document, documentId, query, matches: [{ section, heading, text, score }] }` |
| Annotations | `readOnlyHint: true` |

Example output, from a real call:

```json
{
  "document": "Mobile_Provider_Billing_Guide.md",
  "documentId": "MOB-BILLING-2026-01",
  "query": "What is the cost of extra internet?",
  "matches": [
    { "section": "8.1", "heading": "What is the cost of extra internet?", "text": "Each additional 10 GB block beyond 20 GB costs $10. ...", "score": 10.68 },
    { "section": "3.2", "heading": "Additional internet blocks", "text": "Each additional 10 GB block costs $10. A partially used additional block is charged as a full block. ...", "score": 7.1 }
  ]
}
```

The output follows the format in Billing Guide §9. The result also comes back as MCP `structuredContent`, so the agent can cite `section` directly.

### Indexing approach

The guide is indexed **once at start-up**. The server log shows `Indexed 26 sections ... in 2 ms`. Tool calls only read the prebuilt index.

1. **Chunking** (`src/chunker.ts`). Every numbered heading becomes one chunk: `### 3.2 ...` becomes section `3.2`. A `##` section becomes a chunk only if it has text of its own (e.g. §1, §9), so §3 doesn't duplicate §3.1–3.3. The text before §1 becomes section `0`. Headings inside code blocks are ignored. Markdown emphasis is removed.
2. **Index** (`src/searchIndex.ts`). This is an in-memory **BM25** full-text index.
   - Tokens are lower-cased words and numbers. Stop words are dropped, and a light stemmer folds forms like `blocks` to `block`.
   - Heading words count twice.
   - A small synonym table maps user wording onto the guide's vocabulary (`extra` → `additional`, `complaint` → `dispute`, `overdue` → `late`). Synonym terms carry half the weight of the words the user typed.
   - Results below 35% of the best score are dropped. A query with no matching terms returns `matches: []`.
3. **Why not embeddings:** the document has 26 short sections. BM25 plus synonyms finds the right section for every test query, needs no API key and no vector DB, and is deterministic, so unit tests can check exact sections.

Every tool call is logged as one JSON line (`event: tool_call`, query, returned sections, ms). These lines feed the tool traces.

### Run locally

```bash
npm run dev -w mcp-server            # http://localhost:4000/mcp, health at /health
npm run search -w mcp-server -- "can I pay part of my bill"   # query the index from the CLI
```

If `MCP_API_KEY` is set, every `/mcp` request must send it in the `x-api-key` header; otherwise the endpoint returns 401. The server is stateless: a new MCP server and transport are created for each POST, and they all share the same index. This works when requests are spread across instances. `GET`/`DELETE /mcp` return 405.

### MCP retrieval tests

`npm test -w mcp-server` runs 28 tests: chunking, retrieval, the MCP protocol in memory, and a real Streamable HTTP client. None of them need a network, cloud or LLM. The three required retrieval tests are:

| # | Query (user wording) | Expected sections |
|---|---|---|
| 1 | "How much do I pay if I use more than 20 GB of data?" | 3.2 *Additional internet blocks* (with FAQ 8.1) |
| 2 | "Can I pay just a portion of my bill now and the rest later?" | 8.3 first, 5.1 *Full and partial payments* included |
| 3 | "I think my bill is wrong, how do I file a complaint?" | §7 / FAQ 8.4, with the 15-day window in the text |

## Roadmap
1. [x] Billing API: data model + PostgreSQL + 5 endpoints + business logic
2. [x] Billing API: JWT auth, versioning (`/api/v1`), Swagger, unit tests
3. [x] MCP Server: chunking + index + `search_billing_documentation`
4. [ ] Agent: Claude tool calling + MCP client + REST via gateway + payment confirmation
5. [ ] Local run: gateway in front of the API (no Docker)
6. [ ] Azure deploy: PostgreSQL, API, MCP, APIM
7. [ ] Docs: ER diagram, tool traces for 3 scenarios, 3 MCP retrieval tests, demo video

## Assumptions

**Billing**
- Money is stored as integer cents. Payments accept at most 2 decimals; anything more precise is rejected with 400.
- "Per started block" means rounding up. For phone, 1,001 minutes costs $10. For internet, 20,001 MB costs $60.
- The $50 internet base fee is charged every month, even when internet usage is 0, as Billing Guide §3.1 states. A month with no usage at all therefore costs $50.
- 1 GB = 1,000 MB, as the spec states.
- Add Usage records 10 minutes (PHONE) or 1 MB (INTERNET) per unit. The optional `units` field (default 1) adds many units in one call. It is a convenience for demos and seeding.
- A bill exists only after Calculate Bill has been called. Query or pay on an uncalculated month returns 404.
- Recalculating keeps the amount already paid. If the new total is below that amount, the remaining balance is 0 and the bill stays PAID.
- The spec's "Apr 2025 75$" is treated as an illustrative value. These pricing rules only produce totals of $50 + $10·n.

**Payments**
- Payments are simulated, with no card processing.
- A duplicate `transactionId` returns 409 and leaves the balance unchanged.
- An amount above the remaining balance returns 422 `AMOUNT_EXCEEDS_BALANCE`. Paying a fully paid bill returns 422 `BILL_ALREADY_PAID`.
- Each payment runs in a DB transaction with `SELECT … FOR UPDATE` on the bill row. Concurrent payments therefore cannot overpay.

**Identity and authorization**
- Login issues a JWT (HS256, 1 h).
- A SUBSCRIBER token can only access its own subscriber number. Any other number returns 403. This is what stops the AI agent from reading another person's data just because their number appears in a prompt.
- An ADMIN token can act on any subscriber.
- Query Bill is unauthenticated because the spec says so.

**Errors**
- Every error uses the shape `{ "error": { "code", "message", "details?" } }`. The status codes are 400 / 401 / 403 / 404 / 409 / 422 / 500.
