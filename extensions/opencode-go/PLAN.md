# opencode-go — native OpenCode Go provider for pi

Goal: use an **OpenCode Go** subscription as a first-class pi provider — one
browser sign-in, native model picker entry, and a `/usage` view of the rolling
5-hour / weekly / monthly allowance.

## What we learned (researched + live-verified 2026-10-09)

- **Gateway**: `https://opencode.ai/zen/go/v1` (`/chat/completions`,
  `/responses`, Anthropic `/messages`). Auth is `Authorization: Bearer <key>`
  and it **only accepts workspace service keys (`oc_sk_…`)**, not Console
  session tokens. It also requires an `x-opencode-session` header (pi's built-in
  provider already sends it).
- **Usage**: `GET /api/go/status` returns
  `{ access: { meters: { fiveHour, week, month: { resetsAt, limitMicroCents,
  usedMicroCents } } } }`. Money is micro-cents (1e-8 USD). 5h = 20%, week =
  50%, month = 100% of the Go plan. The service key works here too.
- **Auth**: OpenCode Console runs an OAuth 2.0 server at
  `https://opencode.ai/console`. The **device authorization grant** (public
  client `opencode-cli`) is the flow OpenCode itself uses:
  `POST /auth/device/code` → approve in the browser →
  `POST /auth/device/token` → `{ access_token, refresh_token, expires_in }`.
  The session token works for `/api/user`, `/api/orgs`, and the Console API.
- **Console API**: with a session token, `GET/POST /api/service-accounts`
  (plus `POST /api/service-accounts/:id/keys`) mints service keys — the same
  thing the Console's "API key" button does. Session-token calls need
  `x-org-id`.
- The Auth-Code + PKCE flow is gated behind an undocumented `resource`
  parameter and a first-party-only client, so it was abandoned in favour of the
  official device grant.

## Design

```
extensions/opencode-go/
├── index.ts    register opencode-go (built-in catalog + provisioning login), /usage, status widget
├── config.ts   server origin, client id, service-account + key naming
├── oauth.ts    device flow, Console user/org lookup, API-key provisioning
├── discovery.ts live Go model discovery + models.dev enrichment (cached)
├── usage.ts    fetch/parse/format Go meters
└── panel.ts    /usage overlay
```

### Login (`/login opencode-go`)

1. Device authorization grant with `opencode-cli`; pi shows the code/URL and we
   also open the pre-filled approval page.
2. Read the account + workspace (`/api/user`, `/api/orgs`).
3. Ensure the `pi` service account exists, revoke any active key with this
   machine's name (`pi-<host>`), then create a fresh key and store it as pi's
   `api_key` credential for `opencode-go`.

No OAuth credential is persisted, so there is no token refresh — a service key
is static. `OPENCODE_API_KEY` and any stored key still resolve through the
built-in api-key path.

### Provider

Reuse `opencodeGoProvider()` from
`@earendil-works/pi-ai/providers/opencode-go` (per-model wire API, base URLs,
`x-opencode-session`) and replace only `auth.apiKey.login` with the provisioning
flow above. The registered model list is the built-in catalog plus a live
overlay from `GET /zen/go/v1/models` (models.dev-enriched, cached 12h in
`~/.pi/agent/opencode-go-models.json`), so `/model` tracks the current Go list.

### UI

- `/usage` — overlay with three used-vs-limit bars (`$` + `%` + reset
  countdown); `notify` fallback outside the TUI.
- Footer status — `go 5h 62% · wk 31% · mo 44%`, refreshed on session start and
  every 5 minutes.

## Notes / caveats

- Some Go models (e.g. DeepSeek V4) require the workspace "Global regions"
  privacy setting; the gateway returns a clear 400 otherwise.
- Provisioning creates a revocable `oc_sk_` key named `pi-<host>` under a `pi`
  service account in your workspace.
- The Console OAuth server is undocumented and may change.
