# cost-tracker — build plan

Track the development cost of everything in this repo, automatically, from pi's
own session usage. Built first so that all subsequent work (tests included) is
measured.

## Why

pi persists every assistant message's `usage` (input, output, cacheRead,
cacheWrite, totalTokens, and exact provider-computed `cost`) into the session
JSONL. That is a complete, authoritative ledger already on disk. We only need to
window it by "run" and render it.

## Flow

```sh
# start a tracked run (from inside pi)
/cost start semantic-search

# ... do work in one or more sessions ...

/cost stop
# -> finalizes the run, appends to the ledger, regenerates the README table
```

Also available from a shell (same state):

```sh
pnpm cost start semantic-search
pnpm cost status
pnpm cost stop
pnpm cost report
pnpm cost export
```

## How attribution works

- A **run** is `{ label, cwd, startedAt, stoppedAt }`.
- Final cost = sum of all usage entries in `<agent>/sessions/<slug(cwd)>/*.jsonl`
  whose entry timestamp falls in `[startedAt, stoppedAt]`.
- Included: assistant messages, tool-result nested usage, `usage` entries
  (cache warming), compaction and branch-summary usage.
- Live status during a session accumulates `message_end` usage in memory; the
  final number always comes from re-parsing the session files, so it survives
  reloads and never double-counts.

## Storage

State lives in pi's agent dir so it never pollutes unrelated repos:

```
~/.pi/agent/cost-tracker/
  active.json     # current run, if any
  runs.json       # finalized runs (array)
```

The versioned artifact is the generated markdown table in the repo `README.md`,
between:

```
<!-- COST:START -->
<!-- COST:END -->
```

`export` rewrites that block from `runs.json` + seeded history, aggregated by
label. Existing historical numbers (measured before the tracker existed) are
seeded so the table stays complete.

## Module map

```
extensions/cost-tracker/
  index.ts        # extension: events, live status, /cost command
  ledger.ts       # pure logic: parse sessions, window, aggregate, render
  cli.ts          # shell entrypoint: start/stop/status/report/export
  PLAN.md
  ledger.test.ts
  index.test.ts
```

## pi integration

| API | Purpose |
| --- | --- |
| `on("session_start")` | load active run, render status |
| `on("message_end")` | accumulate live usage, update status |
| `registerCommand("cost")` | `start` / `stop` / `status` / `report` / `export` |
| `ctx.ui.setStatus("cost", …)` | live `$0.004 · 12.4k tok` in the footer |

## Test-first list (vitest)

`ledger.test.ts`
- parses assistant / toolResult / usage / compaction usage from a JSONL fixture
- derives the session dir slug exactly like pi (`--Users-...-proj--`)
- windows records by timestamp and sums all usage fields
- aggregates by label and sorts by cost
- renders the markdown table and totals
- idempotent block upsert between `COST:START` / `COST:END`
- `formatUsd` / `formatTokens` / `formatDuration` edge cases

`index.test.ts`
- `/cost start` writes `active.json`
- `/cost stop` sums the window, appends a run, clears active, exports
- unknown subcommand is a no-op with a helpful message
- live accumulation ignores non-assistant messages

## Non-goals

- No per-tool or per-file cost attribution (message granularity only).
- No cloud sync; local JSON + README only.
- No historical backfill by scanning every session ever (seeded manually).
