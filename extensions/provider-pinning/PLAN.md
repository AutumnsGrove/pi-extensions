# Plan: OpenRouter provider pinning for pi (`provider-pinning` extension)

## Why

Prompt caching only pays off if consecutive requests hit the same upstream
provider. OpenRouter load-balances a model across many endpoints (DeepSeek's own
API, Morph, Fireworks, Together, BaseTen, …), each with its own KV cache. When
routing hops between them, every request is a cold cache. Today `/fast` even
sets `provider.sort = "throughput"`, which actively encourages hopping.

Goal: let the operator see every provider endpoint for the current model and
pin the one they want, so all requests go there and the cache stays warm.
Secondary goal: nice enough data (cost, cache pricing, discount, quantization,
speed, latency, uptime, implicit-cache support) to make that choice well.

## What the codebase already gives us

- `@earendil-works/pi-ai` model config supports
  `compat.openRouterRouting`, sent verbatim as the request body `provider` field:
  `order`, `only`, `ignore`, `allow_fallbacks`, `sort`, `quantizations`,
  `max_price`, `preferred_min_throughput`, `preferred_max_latency`,
  `data_collection`, `zdr`, `require_parameters`, `enforce_distillable_text`.
- The `before_provider_request` extension event lets us mutate `payload.provider`
  per request (the existing Ori extension already does this for `fast`/`zdr`).
- Ori already sends a stable `x-session-id` header for OpenRouter
  (`applyOpenRouterAuthHeader`), which gives OpenRouter sticky routing. Pinning
  adds determinism on top, and wins over `sort`.
- Extension discovery: `<agent-dir>/extensions/` (`~/.pi/agent/extensions/`),
  user-level, auto-loaded. Does not collide with Ori's generated files in
  `~/.ori/pi/` (those get rewritten on every `ori pi` launch).

## Ground truth: the endpoints API

`GET {baseUrl}/models/{modelId}/endpoints`

- `baseUrl` default `https://openrouter.ai/api/v1`; honour Ori's
  `ORI_OPENROUTER_BASE_URL` / `ORI_OPENROUTER_REGION` if present.
- Public, but **latency/throughput only populate when the request carries the
  API key** (`Authorization: Bearer $OPENROUTER_API_KEY`). Verified:
  anonymous → `latency_last_30m: null`; authenticated → percentile objects.

Response shape (confirmed live for `deepseek/deepseek-v4.1-flash`):

```jsonc
{ "data": { "id": "...", "endpoints": [ {
  "name": "Morph | deepseek/deepseek-v4.1-flash-20260910",
  "provider_name": "Morph",
  "tag": "morph/fp8",                 // slug, sometimes with /quant or /variant
  "quantization": "fp8",              // unknown | fp8 | fp4 | ...
  "context_length": 1048576,
  "max_completion_tokens": 943718,
  "pricing": {
    "prompt": "0.000000021",          // $/token, string
    "completion": "0.000000383",
    "input_cache_read": "0.000000008",
    "input_cache_write": null,
    "discount": 0.3                   // fraction off list price
  },
  "supported_parameters": ["tools","reasoning","reasoning_effort", ...],
  "supports_implicit_caching": false, // true only for DeepSeek first-party here
  "uptime_last_30m": 99.87,
  "latency_last_30m": {"p50":636,"p75":745,"p90":1022,"p99":3045},   // only with key
  "throughput_last_30m": {"p50":73,"p75":92,"p90":120,"p99":167}     // tokens/s, only with key
} ] } }
```

Notable real data for the model in question: DeepSeek first-party is the only
endpoint with `supports_implicit_caching: true` and is cheapest-ish, while
`tag` has copies like `baseten/fp8` twice and suffixes like `fireworks/us`,
`baseten/fast`, `deepinfra/fp8` — so the pin must store the **exact tag**, not
just the provider name.

## How pinning is applied

One hook, merged non-destructively so it composes with Ori's `fast`/`zdr`:

```ts
// before_provider_request
const pin = pins[payload.model];
if (pin) {
  payload.provider = {
    ...(payload.provider ?? {}),       // keep zdr / data_collection if set
    only: [pin.tag],
    allow_fallbacks: pin.allowFallbacks,
  };
  delete payload.provider.sort;        // a pin means "do not re-sort across providers"
}
```

- Strict (default): `only: [tag]`, `allow_fallbacks: false` → zero hopping.
- Preferred: `allow_fallbacks: true` → fall back only if the pinned endpoint is
  down; still no cost/throughput reshuffling.
- `sort` is deleted whenever a pin is active so `/fast` can't fight the pin.
- Pin keyed by exact `payload.model` id.

## Files

Self-contained dir `~/.pi/agent/extensions/provider-pinning/`:

| File | Responsibility |
|---|---|
| `index.ts` | Extension factory: commands, events, status, wiring |
| `config.ts` | load/save/atomic-write `provider-pins.json` |
| `endpoints.ts` | fetch + validate + cache `/models/{id}/endpoints` |
| `routing.ts` | pure `applyPin(payload, pin)` merge |
| `format.ts` | `$/M` prices, discount %, context, tok/s, ms, uptime |
| `table.ts` | the TUI table component (SelectList/ScrollView based) |
| `*.test.ts` | pure-function tests (`node:test` via jiti/tsx) |
| `PLAN.md` | this file |

No npm deps: `fetch`, `node:fs`, `node:path` only. Types from
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

## Config (`provider-pins.json`, next to `settings.json`)

Use `getAgentDir()` (respects `PI_CODING_AGENT_DIR`).

```json
{
  "version": 1,
  "pins": {
    "deepseek/deepseek-v4.1-flash": {
      "tag": "deepseek",
      "providerName": "DeepSeek",
      "allowFallbacks": false,
      "quantizations": [],
      "updatedAt": "2026-10-02T..."
    }
  }
}
```

Atomic write (tmp + rename). Missing/corrupt file → empty map + warning, never
crash. Optional `endpoints-cache.json` (model → response + `fetchedAt`) so the
table opens instantly and works offline; TTL ~5 min, stale shown with a marker.

## UI (`/pin`)

`ctx.ui.custom()` → a component with a header, the table, a detail block, and a
hint/footer. Uses the injected theme; every line width-safe with
`truncateToWidth`/`visibleWidth`.

Columns (order is the recommended default; `s` cycles sort):
`●`, Provider, tag, Quant, In $/M, Out $/M, Cache R $/M, Cache W $/M, Disc %,
Ctx, Max out, tok/s p50, Lat ms p50, Uptime %, Implicit-cache.

- `●` marks the pinned row; `✓` marks the provider OpenRouter actually served
  last (from `provider_stream_event` when available).
- "Default routing (no pin)" is row 0; selecting it clears the pin.
- `supports_implicit_caching` is surfaced as a distinct badge: it is the single
  best proxy for "cache will actually hit here".
- Wide terminals (≥ ~120 cols): full table. Narrow: compact subset
  (Provider, In, Out, Cache R, Ctx, tok/s, Lat) plus a detail pane for the
  highlighted row with everything, including `supported_parameters`.

Keys:
- `↑/↓` or `j/k` move, `Enter` pins the highlighted tag
- `f` toggles strict ⇄ allow-fallback (only when a row is pinned/selected)
- `s` cycles sort: recommended(cache) → price → speed → latency → uptime
- `/` filter, `Esc` cancel, `d` clear pin
- When the endpoint list is empty/unavailable: show cached/disk data + warning,
  else offer "pin by tag…" text input via `ctx.ui.input()`.

Recommended sort key: `supports_implicit_caching` first, then
`input_cache_read` ascending, then `prompt` ascending.

## Commands / status

- `/pin` — open the table for the current model.
- `/pin <tag>` — pin directly (`/pin deepseek`).
- `/pin off` — clear the current model's pin.
- `/pins` — list all pinned models as text (non-TUI friendly).
- Status line via `ctx.ui.setStatus("openrouter-pin", "pin: DeepSeek")`,
  restored on `session_start` and refreshed on turn start / model select.

## Events

- `session_start`: load config, set status from the session's model.
- `before_provider_request`: apply the pin (and update status if the model changed).
- `provider_stream_event` (best-effort): capture the actually-served provider to
  show `✓` and to power a tiny "last 5 providers seen" debug line; directly
  answers "am I still hopping?".
- `session_shutdown`: flush any pending endpoint-cache write (idempotent).

## Edge cases / risks

- Model aliases (`~deepseek/...`, `:free`, `:batch`): normalize by trying the id
  as-is, then stripping a leading `~`/suffix; store the pin under the exact id
  pi sends.
- `tag` is not unique across rows (saw duplicate `baseten/fp8`); match by tag
  and show name/quant to disambiguate; if two rows share a tag, pin the tag and
  constrain with `quantizations` when they differ only by quant.
- Strict `only` hard-fails if the endpoint lacks a needed parameter
  (`tools`, `reasoning`). Detail pane shows `supported_parameters`; the table
  warns (⚠) when `tools` is absent. `f` gives the safe fallback.
- Latency/throughput absent without a key → show `—`.
- Prices are per-token strings; render `$ / M` and never float-format into `$0.00`.
- Non-TUI modes: guard `ctx.ui.custom` behind `ctx.hasUI`; `/pin <tag>` and
  `/pins` still work.
- Do not import Ori's files (they are regenerated); read its env vars only.
- Must not break Ori's provider suppression or its `fast`/`zdr` controls.

## Milestones

1. **Plumbing** — dir + config load/save + `applyPin` + `before_provider_request`
   + `/pin <tag>` / `/pin off`. Prove with a hardcoded pin that requests carry
   `provider.only` (temporary log / debug provider).
2. **Data** — authenticated endpoints fetch, validate, in-memory + disk cache,
   price/format helpers, and unit tests for the pure parts.
3. **Table** — read-only table with arrow selection, wide/narrow layouts,
   Enter to pin, Esc/clear.
4. **Polish** — status line, persistence, `f`/`s`/`/` keys, error/offline states,
   `provider_stream_event` served-provider marker.
5. **Verify** — pin `deepseek`, run several turns, confirm the same provider is
   served each time (OpenRouter `/generation?id=` or the served `✓` marker) and
   that cached-token counts rise. Update this plan with what changed.

## Testing / verification

- Pure functions (`format`, `endpoints` parse, `applyPin`, sort) unit-tested with
  `node --test` (no repo dependency; tests live beside the code).
- Manual: `/pin` navigation, narrow/wide, offline (disable network), corrupt
  config, missing key.
- Live proof on the dev flow: after pinning, watch `provider_stream_event` and/or
  OpenRouter generation records across ≥5 turns; expect one provider only.
- Regression: `/fast` and `/zdr` still behave when no pin is set.

## Resolved decisions

1. License: **MIT**.
2. Default mode: **strict** (`only`, no fallbacks).
3. Pin scope: **global per model**, persisted across sessions in
   `provider-pins.json`.
4. Sort: **hard-prefer `supports_implicit_caching`**, then cache-read price.
5. Surface: `/provider` (plus `/pin` alias, `/pins`, and `Ctrl+Shift+K`).

## Status: shipped

- `before_provider_request` rewrites `provider.only` / `allow_fallbacks` and
  drops `sort`; verified end-to-end that the pin reaches the wire.
- Endpoints fetched with the API key (latency/throughput percentiles), parsed,
  cached in memory and on disk, with alias/variant fallback and offline reuse.
- Full table UI with arrows, `Enter`, `f`, `s`, `/`, `d`, `Esc`, wide/narrow
  layouts, and a detail pane (`supported_parameters`, quant, percentiles).
- Served provider read from the OpenRouter stream body (`provider`), shown as
  `✓` and in the status line.
- `/models` bridge: a notification nudge when a chosen model has no pin. The
  built-in `ModelSelectorComponent` exposes no hook for adding a button, so an
  in-dialog button is not possible without replacing the component.
- Tests: 36 unit + wiring tests; `pnpm check` clean.

### Possible follow-ups

- A `/providers` alias and per-model pin templates.
- Show real per-request cache-hit counts from OpenRouter usage chunks.
- Optional "prefer" mode surfaced per pin rather than only via `f`.
