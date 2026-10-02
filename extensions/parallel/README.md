# parallel

Parallel-backed web search and page reading for pi, with a local monthly quota
hard cap and model-summarized page reading.

pi has no built-in way to read the web. This extension adds two tools backed by
[Parallel](https://parallel.ai)'s Search and Extract APIs, and makes two
guarantees the fetch tools usually don't: page content can be read by the
active pi model instead of landing in context raw, and the account can never be
pushed past a locally enforced monthly budget.

## Usage

| Command | What it does |
| --- | --- |
| `/parallel-login` | OAuth 2.0 + PKCE browser sign-in. Stores the key in pi's auth store. |
| `/parallel` | Show auth and month-to-date quota status. |
| `/parallel-logout` | Remove the stored Parallel key. |
| `/parallel-reset-quota` | Clear the local counter if it drifted (does not touch the account). |

The extension also registers a `parallel` auth provider, so pi's native
`/login parallel` and `/logout` work too.

### Tools

**`web_search`**

| Parameter | Notes |
| --- | --- |
| `objective` | Required. The goal driving the search. |
| `search_queries` | Required. 2–3 focused keyword queries. |
| `mode` | `turbo`, `fast` (default), `basic`, `advanced`. |
| `max_results` | Default 10. |

**`web_fetch`**

| Parameter | Notes |
| --- | --- |
| `urls` | Required. Up to 20. |
| `objective` / `search_queries` | Focus the extracted excerpts. |
| `full_content` | Defaults to `true` when `prompt` is set, else `false`. |
| `prompt` | When set, the pages are handed to a pi model with this prompt; only the model's answer is returned. |
| `model` | Summarizer as `provider/id`; defaults to the active model. |

Passing `prompt` is the point of `web_fetch`: instead of returning tens of
thousands of tokens of page markdown, the active model reads the pages and
returns just the answer. The nested model call's `usage` is attached to the tool
result, so pi adds its token cost to the session totals exactly like any other
model call.

```text
web_fetch({ urls: ["https://example.com/changelog"],
            prompt: "What changed recently, with dates?" })
→ <the model's cited answer>
  — summarized with openrouter/deepseek/deepseek-v4.1-flash
```

## Authentication

```
/parallel-login
```

The browser opens to Parallel's consent page. After you approve, the callback is
captured on a loopback port, the authorization code is exchanged with PKCE, and
the key is written to `~/.pi/agent/auth.json` under the `parallel` provider. If
the browser cannot reach the loopback server (SSH, headless), a paste prompt
appears for the callback URL.

Resolution order at request time:

1. Stored credential in `auth.json`.
2. `PARALLEL_API_KEY` environment variable.

## Quota enforcement

Parallel's free tier is *up to 5,000 requests/month* plus $5/month in credits,
and overage is billed. Every request is reserved against a local ledger
**before** it is sent:

| Limit | Default | Behavior |
| --- | --- | --- |
| Soft requests | 3,000 | Warning added to tool output; requests still go through. |
| Hard requests | 4,000 | Call refused with an error, nothing sent. |
| Hard spend | $4.00 estimated | Call refused with an error, nothing sent. |

- `web_search` costs 1 request; `web_fetch` costs 1 request **per URL**
  (matching Parallel billing).
- Failed or cancelled requests are refunded.
- The ledger is keyed by month (`YYYY-MM`) and resets automatically.
- The footer shows `parallel <used>/<hard> · <usd>` live.

The ledger lives at `~/.pi/agent/parallel/quota.json`. It is local: calls made
outside pi (SDK, other tools) will understate real usage, which is what
`/parallel-reset-quota` is for.

### Configuration

Optional file at `~/.pi/agent/parallel/config.json` (see
[`config.example.json`](./config.example.json)):

```json
{
  "softLimitQueries": 3000,
  "hardLimitQueries": 4000,
  "hardLimitUsd": 4,
  "searchMode": "fast",
  "defaultMaxResults": 10,
  "maxSummaryChars": 120000
}
```

The soft limit is clamped to the hard limit. Pricing used for the estimate
(see <https://docs.parallel.ai/getting-started/pricing>):

- Search: `$1/1,000` `turbo`/`fast`, `$5/1,000` `basic`/`advanced`; 10 results
  included, `$1/1,000` beyond that.
- Extract: `$1/1,000` URLs.

## How it works

- **Transport** — `POST https://api.parallel.ai/v1/search` and `/v1/extract`
  with the Parallel key as an `x-api-key` header. Requests carry a stable
  `session_id` and the active `client_model` for correlation.
- **Quota** — `QuotaStore.reserve()` is an atomic read-modify-write guarded by
  a cross-process lock, so parallel tool calls (or concurrent pi processes)
  cannot both slip under a limit. A blocked request throws before the HTTP call.
- **Summarization** — `ctx.modelRegistry.complete()` with the active model; the
  returned `usage` is attached to the tool result so pi records the cost.
- **Auth** — a registered `parallel` provider with an `auth.apiKey.login` that
  runs the OAuth flow, plus a `/parallel-login` command that drives the same
  flow and writes `auth.json` directly. Pi notices the file change (its revision
  check includes inode and nanosecond timestamps) and reloads without a restart.

## Permissions and data

- Reads the `parallel` credential from `~/.pi/agent/auth.json`, or
  `PARALLEL_API_KEY` from the environment.
- Makes HTTPS requests to `api.parallel.ai` (search/extract) and
  `platform.parallel.ai` (OAuth) only.
- Writes the `parallel` credential to `auth.json`, the quota ledger to
  `~/.pi/agent/parallel/quota.json`, and optionally reads
  `~/.pi/agent/parallel/config.json`.
- No telemetry. Search queries and fetched URLs go only to Parallel.

## Notes and limitations

- Only Search and Extract are implemented. Task, Responses, FindAll, and
  Monitor are out of scope.
- We deliberately did **not** use the Parallel Search MCP. See
  [`PLAN.md`](./PLAN.md#mcp-fallback-breadcrumb) for why, and for the recipe to
  switch later if the direct REST integration proves fragile.
- Don't install `@parallel-web/pi-extension` at the same time: it registers the
  same `web_search` / `web_fetch` tool names.

## Development

```bash
pnpm install
pnpm check   # tsc --noEmit
pnpm test    # vitest
```

Built with about **$0.303** of model credits.
