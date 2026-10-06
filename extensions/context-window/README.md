# context-window

Cap the **effective** context window of a model so pi auto-compacts sooner,
without giving up the model's native window.

```
/context              # where did the context go?
/context set 400k     # derive a 400k-window model and switch to it
/context reset        # back to the native model
/context list         # configured limits
```

## Why

Pi compacts when `contextTokens > model.contextWindow - reserveTokens`. A model
with a 1M-token window therefore stays uncompacted until it is nearly full,
even though answer quality often starts to degrade far earlier. There is no
built-in switch to lower the window, so this extension adds one.

## How it works

`/context set 400k` on `deepseek/deepseek-v4.1-flash` writes a **real derived
model** to `models.json`:

```
deepseek-v4.1-flash-400k  =  deepseek-v4.1-flash  with contextWindow = 400000
```

The extension then switches the session to that model. Because it is an
ordinary registry model, everything follows the reduced window automatically:

- pi's own auto-compaction fires at `400k - reserve`
- the footer percentage and `ctx.getContextUsage()` use 400k
- `/session` and cost accounting stay correct
- it appears in `/model`, and a resumed session restores it without the
  extension being involved

`models.json` upserts definitions by id, so a derived model never disturbs other
providers, models, or your hand-written config.

## Sample panel

```text
Context usage

Window      400k  (native 1M)
Used        ████████░░░░░░░░░░  187.4k  46.9%
Compact at  383.6k  (95.9%)
Reserve     16.4k

Breakdown (estimated)
  Tool results      ███████████░░░░░░░  118.4k  63.2%
  Assistant text    ███░░░░░░░░░░░░░░░   31.4k  16.8%
  User messages     █░░░░░░░░░░░░░░░░░   12.0k   6.4%
  Thinking          █░░░░░░░░░░░░░░░░░    9.8k   5.2%
  System prompt     █░░░░░░░░░░░░░░░░░    8.1k   4.3%
  Tool calls        █░░░░░░░░░░░░░░░░░    6.7k   3.6%
  Total                                187.4k
```

Bars are fixed-width block glyphs: the top bar is used-vs-window, each
breakdown bar is that category's share of the estimate.

## Interaction with other extensions

The derived id is local only. Pi sends `model.id` as the upstream model slug, so
a request for `...-400k` would otherwise be rejected as an unknown model. The
extension rewrites outgoing request payloads back to the base id, which also
keeps the rest of the stack consistent:

- **provider-pinning** applies the base model's pin. Its request handler runs
  after this one (package entries load in path order), so it sees the real base
  id; it also maps derived ids to their base for the status badge, the
  `/provider` picker, and endpoint discovery.
- Cache accounting, `responseModel`, and cost stay attributed correctly because
  only the outbound `model` field changes.

## Persistence

| File | Contents |
| --- | --- |
| `<agent-dir>/context-window.json` | Source of truth: `provider/baseId -> { limit, variantId }` |
| `<agent-dir>/models.json` | Derived model definitions the registry reads at startup |

On session start, a configured limit is re-applied if the session opens on the
base model, so new sessions inherit the cap. Run `/context reset` to remove the
derived model and go back to the native window.

## Command reference

| Command | Effect |
| --- | --- |
| `/context` | Panel: effective window, native window, used %, compact-at, reserve, and an estimated breakdown by category |
| `/context set <size>` | Create/update the derived model and switch to it. Sizes: `400k`, `1m`, `1.5m`, `400000` |
| `/context reset` | Switch back to the base model and delete the derived definition |
| `/context list` | Show every configured limit |

## Caveats

- Limits are stored per base model and are global (all projects).
- Derived ids follow `<baseId>-<size>` (e.g. `-400k`, `-1.5m`). Setting a new
  size retires the previous derived id.
- Per-model request headers configured on a base model are copied to the derived
  definition; provider-level auth always carries over.
- Setting a limit below 32k is rejected (it mostly fights the reserve and
  keep-recent budgets), as is a limit at or above the native window.
- Virtual models are rejected: they route to a physical model, so set the limit
  on the physical model instead.
- If the running registry does not reload the new `models.json` entry, `/context
  set` still applies the reduced window as a session override and warns; restart
  pi to register the derived model permanently.
