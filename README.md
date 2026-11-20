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
| `gateway` | Local API Gateway (route table, JWT check, rate limit) mirroring Azure APIM |
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

## AI Agent (`agent`)

The agent is a terminal chat assistant. **Claude** decides which tools to call, and the agent code runs them.

- **LLM:** Claude Opus 5.5 (`claude-opus-5-5`) through the Messages API, with effort `medium` and adaptive thinking. The tool loop is written by hand in `src/agent.ts`: send the history, run every `tool_use` block, return all `tool_result`s in one message, and repeat until `end_turn`.
  - The full assistant content is kept in the history unchanged.
  - The `fallbacks: "default"` safety fallback is turned on.
  - The tools and system prompt are prompt-cached across the turns of a session.
- **MCP client:** the agent connects to the MCP server over Streamable HTTP and discovers its tools with `tools/list`. `search_billing_documentation` is therefore not hard-coded in the agent.
- **REST tools:** these call the Billing API through the API Gateway (`GATEWAY_BASE_URL`), and send `Ocp-Apim-Subscription-Key` when it is set.
  - `get_bill` calls Query Bill.
  - `get_bill_details` calls Query Bill Detailed, with paging.
  - `pay_bill` calls Pay Bill.

| Question type | Tools used |
|---|---|
| Policy / pricing rules | MCP `search_billing_documentation` (answer cites §) |
| Live bill, usage, payment | REST via gateway |
| "Why is my bill $70?" | `get_bill_details` + `search_billing_documentation` |

### Safety rules (enforced in code, not only in the prompt)

- **No access to other people's data.** The REST tools act on the logged-in subscriber, whose number is read from the JWT.
  - In a SUBSCRIBER session the tools have **no `subscriberNo` parameter**, so a number typed into the chat cannot redirect a call.
  - If the model sends another number anyway, the agent refuses with 403 before making any HTTP call. The API would also return 403.
- **Explicit payment confirmation (Billing Guide §5.2).**
  - `pay_bill` first reads the stored bill.
  - The CLI then shows the human the subscriber, period, bill total, remaining balance and amount, and waits for `yes`.
  - The model cannot answer this prompt. Any other answer means nothing is sent, and the model is told `NOT_SUBMITTED`.
- **Idempotent payments (§5.3).** Every confirmed payment gets one `transactionId`. A network retry reuses it, so the API answers 409 instead of charging twice.
- **Errors reach the model as data.** API and validation errors come back as `is_error` tool results with the API error code, so the model can explain them instead of guessing.

### Tool traces

Every tool call is printed in the terminal and appended to `agent/traces/trace-<session>.jsonl`. Each entry records the turn, tool, source (MCP/REST), input, gateway calls with status, result and duration. Example from a run against the real API, MCP server and PostgreSQL:

```
USER: Why is my October 2025 bill that amount?
  [tool] REST get_bill_details({"year":2025,"month":10,"pageSize":3})  GET /bills/5551000001/detailed?year=2025&month=10&page=1&pageSize=3 -> 200  OK 35ms
  [tool] MCP search_billing_documentation({"query":"internet blocks and extra minutes pricing"})  OK 3ms
         -> sections [8.1, 2.2, 4.3]
USER: Show subscriber 5551000002's bill
  [tool] REST get_bill_details({"subscriberNo":"5551000002",...})  ERROR 1ms
         -> {"error":{"httpStatus":403,"code":"FORBIDDEN","message":"This session can only access subscriber 5551000001. ..."}}
```

### Run

```bash
# Database, API, MCP server and gateway running (see "Run the whole stack locally"); then:
export ANTHROPIC_API_KEY=...            # Claude API key
export GATEWAY_BASE_URL=http://localhost:8000/billing/v1   # on Azure: the APIM gateway URL
npm start -w agent                      # log in as 5551000001 / pass1234
```

`npx tsx scripts/smoke.ts`, run from `agent/`, plays the three scenarios and both safety cases against the real services. It uses a scripted stand-in for Claude, so it shows the wiring without an API key.

### Tests

`npm test -w agent` runs 16 tests. They use a **scripted fake LLM**, a fake gateway and a fake MCP server, so they need no API key, network or cloud. They cover:
- the MCP-only, REST-only and combined scenarios
- parallel tool results returned in one message
- payment declined (no POST), confirmed, a retry after a network failure (same transactionId), and no bill (no prompt shown)
- refusing another subscriber's number
- invalid tool input, an API 404, a refusal stop reason, and JWT/login parsing

## API Gateway (`gateway`)

All REST traffic goes through the gateway. Clients, the agent included, never call the API directly. The deployed gateway is **Azure API Management**. The local gateway in `gateway/` follows the same route table and rules, so the whole flow runs and is tested without the cloud.

| | URL |
|---|---|
| Gateway base (local) | `http://localhost:8000/billing/v1` |
| Gateway base (Azure) | `https://apim-se4458-7ysgwq.azure-api.net/billing/v1` |
| Backend (not called by clients) | `http://<api>/api/v1` |

### Routes

The route table is `gateway/src/routes.ts`. The gateway publishes only these routes:

| Gateway route (`/billing/v1` + …) | Backend | Protected at gateway |
|---|---|---|
| `POST /auth/login` | `POST /api/v1/auth/login` | – |
| `POST /usage` | `POST /api/v1/usage` | JWT |
| `POST /bills/calculate` | `POST /api/v1/bills/calculate` | JWT |
| `GET /bills/{subscriberNo}` | `GET /api/v1/bills/{subscriberNo}` | – |
| `GET /bills/{subscriberNo}/detailed` | `GET /api/v1/bills/{subscriberNo}/detailed` | JWT |
| `POST /payments` | `POST /api/v1/payments` | JWT |

### Gateway rules (same as the APIM policies)

1. **Subscription key.** When `GATEWAY_SUBSCRIPTION_KEY` is set, a missing or wrong `Ocp-Apim-Subscription-Key` returns 401. The key is removed before the request is forwarded.
2. **Route table.**
   - A path that isn't in the table returns 404 `ROUTE_NOT_FOUND`. This includes other versions such as `/billing/v2/...` and direct `/api/v1/...` calls.
   - A wrong method returns 405 with an `Allow` header.
3. **Rate limit.** Requests are limited per subscription key or client IP, 100 per minute by default. Above that the gateway returns 429 `RATE_LIMITED` with `Retry-After`.
4. **JWT on protected routes.** These need a Bearer HS256 token with issuer `billing-api` and audience `billing-clients`, signed with `JWT_SECRET`. Otherwise the gateway returns 401 and the request never reaches the API. The API still does its own per-subscriber 403 check.
5. **Forwarding.** The gateway adds `x-request-id`, `x-forwarded-*` and `x-gateway-route`. Backend errors pass through unchanged.
   - If the backend is down, the gateway returns 502 `BAD_GATEWAY`.
   - If it times out, the gateway returns 504 `GATEWAY_TIMEOUT`.
6. **Logging.** Each request is logged as one JSON line: request id, method, path, route, status and ms.

Gateway errors use the API's error shape, plus `"source": "gateway"`. Example from a real run:

```
$ curl -i http://localhost:8000/billing/v1/bills/5551000001/detailed?year=2025&month=10
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
{"error":{"code":"UNAUTHORIZED","message":"A valid Bearer token is required for this operation.","source":"gateway"}}
```

`npm test -w gateway` runs 12 tests against a fake backend:
- **Success cases:** public and protected routing, body, query and header forwarding, passing through backend errors, and literal-route precedence.
- **Failure cases:** missing, expired and forged JWTs, unpublished routes and versions, wrong method, subscription key, rate limit, and a backend that is down.

### Run the whole stack locally

```bash
npm run db:local -w billing-api                                   # 1. PostgreSQL + demo data (keep open)
DATABASE_URL=postgresql://billing:billing@localhost:5432/billing JWT_SECRET=dev-secret \
  npm run dev -w billing-api                                      # 2. API      :3000
npm run dev -w mcp-server                                         # 3. MCP      :4000
JWT_SECRET=dev-secret npm run dev -w gateway                      # 4. Gateway  :8000/billing/v1
npm start -w agent                                                # 5. Agent (needs ANTHROPIC_API_KEY)
```

## Azure deployment

Everything runs in one resource group (`rg-se4458-billing`) in **Sweden Central**, on an Azure for Students subscription.

| Component | Azure service | URL |
|---|---|---|
| API Gateway | API Management, Consumption tier | `https://apim-se4458-7ysgwq.azure-api.net/billing/v1` |
| Billing API | App Service (Linux, F1, Node 22) | `https://api-se4458-7ysgwq.azurewebsites.net` (Swagger at `/docs`) |
| MCP server | App Service (same plan) | `https://mcp-se4458-7ysgwq.azurewebsites.net/mcp` (needs `x-api-key`) |
| Database | PostgreSQL Flexible Server, Burstable B1ms, 32 GB | private to Azure services + the deploy machine |

Clients call only the APIM URL, and every request needs an `Ocp-Apim-Subscription-Key` header.

**APIM setup** (`gateway/apim/`):
- The API is published at `billing`, version `v1`, using the Segment versioning scheme, so the path is `/billing/v1/...`.
- The operations come from the same `gateway/src/routes.ts` table as the local gateway.
- `api-policy.xml` applies to every operation: rate limit, request id, and the error shape with `"source":"gateway"`.
- `protected-operation-policy.xml` adds `validate-jwt` on the 4 protected operations. The signing key is stored as a secret named value.

**Deploy:** after `az login`, run:

```powershell
powershell -ExecutionPolicy Bypass -File infra\azure\deploy.ps1 -Location swedencentral
```

Every step is idempotent, and you can run a subset of steps, e.g. `-Steps "deploy,apim"`. The script:
- generates the secrets
- creates the database and loads the demo data
- builds and zip-deploys both services
- configures APIM

Names, secrets and URLs are written to `.env.azure`, which is git-ignored.

**Verified against the cloud deployment** (2026-11-20):

| Request through APIM | Result |
|---|---|
| Query Bill without a subscription key | 401 `SubscriptionKeyNotFound` |
| Query Bill with the key | 200 |
| Detailed without a JWT, or with a forged one | 401 `UNAUTHORIZED`, rejected at the gateway |
| Detailed with a valid JWT | 200 |
| Detailed for another subscriber | 403 from the API |
| Unpublished path | 404 `OperationNotFound` |
| Agent smoke script, all 6 scenarios (MCP and REST through APIM) | Passed |

**Notes:**
- **Region.** Germany West Central is in the Students allowed list, but PostgreSQL provisioning is restricted there for this subscription, so everything runs in Sweden Central.
- **Cost.** The deployment stays inside the Students free allowances:
  - PostgreSQL B1ms: 750 h/month for 12 months
  - App Service F1: free
  - APIM Consumption: 1M calls/month free
- **F1 cold starts.** On F1 the apps sleep when idle, so the first request after a pause can take 10–30 s.
- **Rate limit.** On the Consumption tier `rate-limit-by-key` isn't available. APIM limits per subscription (100 calls/min), while the local gateway limits per key or IP.

## Roadmap
1. [x] Billing API: data model + PostgreSQL + 5 endpoints + business logic
2. [x] Billing API: JWT auth, versioning (`/api/v1`), Swagger, unit tests
3. [x] MCP Server: chunking + index + `search_billing_documentation`
4. [x] Agent: Claude tool calling + MCP client + REST via gateway + payment confirmation
5. [x] Local run: gateway in front of the API (no Docker)
6. [x] Azure deploy: PostgreSQL, API, MCP, APIM
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
