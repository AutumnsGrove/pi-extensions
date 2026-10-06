# context-window — plan

## Problem

Pi compacts when `contextTokens > model.contextWindow - reserveTokens`. On a 1M
model that means the conversation can grow until quality has already degraded
before the first auto-compaction. Users want to cap the *effective* window (say
400k) so compaction happens earlier and the run keeps producing good output.

Pi has no first-class context-window override:

- `compaction.modelOverrides[].reserveTokens` in settings nudges the trigger but
  has no runtime setter, needs a reload, and does not change the reported window
  or the footer percentage.
- `ctx.compact()` can be called on a threshold, but the footer still claims 1M
  and compaction timing is extension-owned.
- `registerVirtualModel` cannot lower limits: compaction and usage use the routed
  **physical** model's window.
- `registerProvider({ models })` replaces a provider's whole model list, which
  clobbers other layers and extensions.
- `models.json` `models[]` **upserts by id**, so it is the one composition-safe
  way to add a model.

## Decision

Represent a reduced window as a **real derived model** in `models.json`:

```
deepseek/deepseek-v4.1-flash-400k = deepseek/deepseek-v4.1-flash, contextWindow 400000
```

and switch the session to it. This is the only approach where pi's own
compaction, footer %, `getContextUsage()`, `/session`, resume, and `/model` all
agree, with no monkey-patching of live runtime objects and no clobbering of other
extensions' registrations.

Source of truth for the chosen limits is the extension's own
`<agent-dir>/context-window.json`; `models.json` is a derived projection.

## Shape

```
extensions/context-window/
├── index.ts        # /context command, set/reset/list/show, session-start apply
├── config.ts       # context-window.json store (source of truth)
├── variant.ts      # models.json upsert/remove + derived model definition
├── breakdown.ts    # token attribution over the session projection
├── format.ts       # size parsing + compact formatting
├── json.ts         # JSONC read + atomic write
├── *.test.ts
├── PLAN.md
└── README.md
```

## Behaviour

- `/context` shows window/native/used/compact-at/reserve plus an estimated
  breakdown (system prompt, summaries, user, assistant text, thinking, tool
  calls, tool results, shell, custom, images).
- `/context set <size>` validates, derives `models.json`, refreshes the registry
  for that provider, `setModel(variant)`, then persists the limit.
- `/context reset` switches back, removes the derived definition, clears config.
- `session_start` re-applies a configured limit when the session opens on the
  base model, so new sessions inherit the cap. Explicit `/model` picks during a
  session are respected; run `/context reset` to use the native window again.

## Roadmap

- Project-local overrides (`.pi/context-window.json`) layered over global.
- Interactive breakdown panel (custom TUI component) with a size picker, instead
  of a text notification.
- Live status widget (`ctx 187k/400k`) and a compact percentage in the status
  line.
- A `reserveTokens` mode for users who prefer to keep the native label but move
  only the compaction trigger.
- `/context why` explaining the largest contributors with per-tool/per-file
  attribution, and a "compact the biggest tool result" action.
- Reconcile missing `models.json` entries on session start instead of only on
  `/context set`.
- Cache the parsed breakdown so repeated `/context` calls do not re-walk the
  projection.
