# Plan: Parallel web search + fetch for pi (`parallel` extension)

## Why

pi has no way to read the web. We want Parallel's Search and Extract APIs as
first-class agent tools, and we want two things the official
`@parallel-web/pi-extension` does not provide:

1. **A local hard cap** so the account can never be pushed past the free tier or
   into paid overage.
2. **Model summarization in `web_fetch`** so a page is read by the active pi
   model (with its token cost tracked in the session) instead of dumping raw
   page text into context.

## Ground truth (verified against live docs, 2026-10)

- Search: `POST https://api.parallel.ai/v1/search`
  body `{ objective, search_queries, mode, session_id, client_model,
  advanced_settings: { max_results } }`; response
  `{ search_id, results: [{ url, title, publish_date, excerpts[] }], warnings,
  usage, session_id }`.
- Extract: `POST https://api.parallel.ai/v1/extract`
  body `{ urls, objective, search_queries, session_id, client_model,
  advanced_settings: { full_content } }`; response
  `{ extract_id, results: [{ ..., full_content? }], errors, warnings, usage,
  session_id }`.
- Auth header: `x-api-key: <PARALLEL_API_KEY>`. Use `/v1`, not `/v1beta`.
- OAuth 2.0 + PKCE against `https://platform.parallel.ai`:
  authorize at `/getKeys/authorize`, exchange at `/getKeys/token`; the returned
  `access_token` **is** the user's Parallel API key. `client_id` is the loopback
  hostname (`127.0.0.1`); `scope=key:read`.
- Pricing: Search `$1/1k` (`turbo`/`fast`) or `$5/1k` (`basic`/`advanced`),
  10 results included, `$1/1k` additional; Extract `$1/1k` URLs.
- Free tier: *up to 5,000 requests/month* plus `$5/month` credits; overage is
  billed. Hence the local ledger is really about never being billed.

## Auth

`auth.ts` implements the flow and a provider registration:

- `generatePkce()` — base64url verifier + S256 challenge.
- `startCallbackListener()` — `node:http` server on `127.0.0.1:0`, path
  `/callback`, resolves with the callback URL.
- `loginWithParallel()` — builds the authorize URL, opens the browser, waits
  for the callback, and races a delayed manual-paste prompt so SSH/headless
  setups still work; validates `state`; exchanges the code for the API key.
- `storeParallelApiKey()` / `clearParallelApiKey()` — atomic read-modify-write
  of `~/.pi/agent/auth.json` under a `.parallel.lock` directory. Pi's
  `AuthStorage` detects the file-revision change and reloads on next read, so
  the key is usable without a restart.
- `parallelProviderLogin()` — the provider's `auth.apiKey.login`, letting pi's
  native `/login parallel` work as well.

Precedence at request time: stored credential, then `PARALLEL_API_KEY`.

## Quota ledger

`quota.ts`:

- Ledger shape `{ version, month, queries, usd, searchRequests, extractUrls, updatedAt }`.
- `monthKey()` = `YYYY-MM`; a ledger from another month is discarded on read.
- `decideQuota()` is pure: it returns allowed/blocked, a reason, and whether the
  soft limit was crossed. Blocking is strict (`next > limit`).
- `QuotaStore.reserve()` performs the check and write **inside a cross-process
  lock** (atomic `mkdir`, stale-lock recovery), so parallel tool calls cannot
  both slip under a limit. `refund()` reverses a failed request; both clamp at 0.
- Defaults: soft `3000`, hard `4000`, hard spend `$4.00`. Configurable in
  `~/.pi/agent/parallel/config.json`; the soft limit is clamped to the hard one.

`web_search` reserves 1 query. `web_fetch` reserves `urls.length` queries and
`urls.length * $0.001`. The reservation happens before the HTTP call; on any
failure the reservation is refunded.

## Summarization

`summarize.ts`:

- `resolveSummaryModel(ctx, override)` — active model by default; `provider/id`
  or bare id override.
- `buildSummaryPrompt()` wraps each page in `<page url="…">`, instructs the
  model to answer only from the provided content and cite URLs.
- `clipPages()` bounds total input (`maxSummaryChars`, default 120k).
- `summarizePages()` calls `ctx.modelRegistry.complete(...)`. The returned
  `usage` is attached to the `web_fetch` tool result, which is how pi adds the
  model's token cost to the session (see `agent-session.js`).

## Tools

Both tools use TypeBox schemas and return model-facing markdown plus small
structured `details`. Large outputs go through pi's `truncateHead`. A soft-limit
warning is prepended to tool output once the month crosses the soft threshold.

## Files

| File | Responsibility |
| --- | --- |
| `index.ts` | Factory: provider, commands, tools, status, events |
| `auth.ts` | PKCE, loopback callback server, token exchange, auth.json storage |
| `client.ts` | Typed `fetch` wrappers for `/v1/search` and `/v1/extract` |
| `quota.ts` | Ledger, limits, atomic reserve/refund |
| `cost.ts` | Price model and USD formatting |
| `config.ts` | Config load/merge and paths |
| `summarize.ts` | Nested pi model call for page reading |
| `format.ts` | Search/extract markdown, page clipping, truncation |
| `*.test.ts` | Unit + mock integration tests |
| `README.md` | Usage and configuration |

## MCP fallback breadcrumb

We deliberately built on the REST API instead of the Parallel Search MCP
(`https://search.parallel.ai/mcp`). Reasons:

- The hard cap must be enforced **before** the request. REST keeps the request in
  our hands so we can reserve and block transactionally; the MCP only gives us
  `tool_call` interception with no usage numbers to reconcile.
- `web_fetch` needs to post-process content (summarize with a pi model). With
  MCP we would wrap `mcp__parallel__web_fetch` anyway.
- Direct REST keeps `mode`/`max_results`/`full_content` under our control.

If the direct integration turns out to be fragile (API changes, auth churn), the
MCP is a viable transport swap:

1. Register the server: `pi.registerMcpServer("parallel", { url:
   "https://search.parallel.ai/mcp" })`. Anonymous use is free but rate-limited;
   pass `headers: { Authorization: "Bearer ${PARALLEL_API_KEY}" }` for higher
   limits. Tools arrive as `mcp__parallel__web_search` / `..._web_fetch`.
2. Consider `exposure: "codemode"` so the raw tools are not declared to the
   model directly, then keep our own `web_search`/`web_fetch` as wrappers that
   call them through `ctx.executeTool`.
3. Re-implement the quota guard as a `pi.on("tool_call")` handler that counts
   `web_search` as 1 and `web_fetch` as `urls.length`, injects `session_id`, and
   returns `{ block: true, reason }` when the ledger is exhausted. Note that
   blocking cannot reconcile actual usage, so the ledger becomes
   accounting-only.
4. Summarization is unchanged: the wrapper still feeds content to
   `ctx.modelRegistry.complete` and returns the model `usage`.

For reference, Parallel also publishes `@parallel-web/pi-extension`
(`web_search`, `web_fetch`, `web_research`, `/parallel-login`, `/parallel`), which
uses the `parallel-web` SDK and the same OAuth provider. It has no local quota
guard; its `web_search` is fixed to `fast` mode.

## Decisions

- Tools are named `web_search` / `web_fetch` (not namespaced in the tool name).
  Don't install the official extension at the same time or the names will
  collide.
- Extract requests full content when summarizing, excerpts otherwise.
- Model cost is tracked by pi (via tool `usage`); it is **not** counted against
  the Parallel quota, since it is not a Parallel request.

## Test strategy

- `quota.test.ts` — thresholds, soft/hard decisions, persistence, refund clamp,
  month rollover.
- `cost.test.ts` — tier pricing and extra-result pricing.
- `config.test.ts` — defaults, clamping, invalid input.
- `format.test.ts` — result/page rendering and clipping.
- `summarize.test.ts` — prompt construction and escaping.
- `auth.test.ts` — PKCE shape and auth.json round-trip/corruption safety.
- `index.test.ts` — registration wiring and the hard-fail path (asserts the tool
  refuses before any network call).
