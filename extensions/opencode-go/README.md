# opencode-go

Use an **OpenCode Go** subscription as a native pi provider — one browser
sign-in, models in `/model`, and a `/usage` view of your rolling allowance.

The extension registers `opencode-go` (the same id pi ships) and keeps pi's
built-in catalog, per-model wire routing (`/chat/completions`, `/responses`,
`/messages`), and `x-opencode-session` header. Only the login is replaced.

## Features

- **One-click browser sign-in** with the official OAuth device flow
  (`opencode-cli`). pi shows a short code and opens the pre-filled approval page.
- **Auto-provisions a Go API key.** Go inference accepts workspace service keys,
  not Console sessions, so after you approve, the extension creates a key named
  `pi-<host>` under a `pi` service account and stores it. No copy-paste.
- **`/login opencode-go`** — the standard pi login flow; `OPENCODE_API_KEY` and
  any stored key still work as the API-key fallback.
- **Live model list** — fetches OpenCode's Go catalog (`/zen/go/v1/models`) and
  merges it with pi's built-in metadata (plus models.dev), cached for 12 hours,
  so `/model` tracks the current Go list.
- **`/usage`** — an overlay with the rolling 5-hour, weekly, and monthly meters
  as used-vs-limit bars (`$` and `%`, plus reset countdowns), each backed by a
  **pace line**: spend vs. the straight-line budget for the window, where the
  window is projected to land, and the remaining `$`/hr or `$`/day.
- **Footer widget** — `go 5h 62% (1h 12m) · wk 31% · mo 44% (12d 0h)`, where
  the parentheticals are the rolling 5-hour and monthly reset countdowns. Usage
  refreshes on session start and every 5 minutes; the countdowns redraw every 30
  seconds.

## Install

```bash
pi install git:github.com/AutumnsGrove/pi-extensions   # or npm/git as usual
```

Or run it directly during development:

```bash
pi -e /path/to/pi-extensions
```

## Log in

```text
/login opencode-go
```

Choose **OpenCode Go account**. Approve the device code in the browser and pi
provisions a key automatically. If the `pi` service account does not exist it is
created; the per-machine key replaces any previous key with the same name.

Sign out with `/logout opencode-go`. The provisioned key can also be revoked in
the OpenCode Console.

## Usage

```text
/usage            # open the usage panel
/usage refresh    # refetch before showing
```

```text
OpenCode Go — usage
updated 2:32:05 PM

Rolling 5h  ██████░░░░░░░░░░░░  62.5%  $12.00 / $19.20   1h 12m
  under pace (-12.0 pts) · tracks to 50% · $2.40/hr left
Weekly      ███░░░░░░░░░░░░░░░░  31.4%  $30.10 / $96.00   3d 4h
  on pace · tracks to 44% · $8.20/day left
Monthly     ████░░░░░░░░░░░░░░░  44.1%  $42.30 / $96.00   12d 0h
  under pace (-10.6 pts) · tracks to 62% · $2.23/day left
```

Pace compares the meter's `used%` to the straight-line budget at this point in
its own window (`elapsed% = (now - startsAt) / (resetsAt - startsAt)`). Positive
drift is `over pace`, negative is `under pace`, and within ±5 points is
`on pace`; `tracks to` projects the current rate to the window's end. Short
windows quote an hourly remainder, the month quotes a daily one.

Limits follow OpenCode Go: the 5-hour window is 20% of the plan, the week 50%,
and the month 100% (so a $60 plan shows $12 / $30 / $60).

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENCODE_CONSOLE_SERVER` | Override the Console origin (default `https://opencode.ai/console`). |
| `OPENCODE_API_KEY` | Workspace service key (built-in fallback; no sign-in needed). |

## How it works

- `oauth.ts` runs the device grant (`/auth/device/code` → approve →
  `/auth/device/token`), reads `/api/user` + `/api/orgs`, then calls
  `/api/service-accounts` (with `x-org-id`) to mint a key.
- `index.ts` registers `opencode-go`, reusing `opencodeGoProvider()` from
  `@earendil-works/pi-ai/providers/opencode-go` and replacing only
  `auth.apiKey.login`.
- `discovery.ts` fetches the live Go ids, enriches them with models.dev metadata,
  and caches the overlay in `~/.pi/agent/opencode-go-models.json`.
- `usage.ts` calls `GET /api/go/status` and converts micro-cents (1e-8 USD) to
  dollars and percentages. It reads `startsAt`/`resetsAt` per meter (month falls
  back to `access.startsAt`/`endsAt`) and `computePace()` compares spend to the
  linear budget; `panel.ts` renders that as the pace line.

## Caveats

- Some Go models (all DeepSeek V4 variants) require the workspace **Global**
  regions privacy setting; the gateway returns a clear 400 until you enable it
  in the Console.
- OpenCode Go is designed for coding-agent traffic; pi's built-in provider sends
  the required `x-opencode-session` and user agent.
- The Console OAuth server is undocumented and may change. The parser is
  defensive and reports a clear "response was not recognised" error.
