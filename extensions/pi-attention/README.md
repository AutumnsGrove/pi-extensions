# pi-attention

One place that decides whether a session needs you, and publishes it.

"sounds played the same 'finished' cue for every settled turn" is the problem
this exists for. With a PR subscription active, a passing CI run wakes the
agent for a turn that has nothing to do, the turn settles, and the cue fires
again — a string of identical sounds with no way to hear which one means the
work is actually finished. `sounds` is audio only, `notify` is banners only,
and `permissions` is about tool safety, so the policy needs its own extension.

```
/attention              current state, configuration, log path
/attention on|off       toggle without editing settings
/attention state        the last decision and why
/attention log [n]      recent verdicts
/attention reload       re-read settings (also happens on session_start)
```

## States

`AttentionChanged` carries `{ state, reason, source, confidence? }`:

| State | Meaning |
| --- | --- |
| `working` | The agent is running a turn |
| `needs_you` | Blocked, asking, a wake that wants a human, or a prompt is open |
| `waiting` | Nothing to do until something external happens (CI running, review pending) |
| `ready` | The PR was deliberately released as done |
| `idle` | Settled with nothing outstanding (an ordinary turn) |

The event is published on the hooks bus, so `sounds` maps it, a configured hook
can act on it, and a remote runner can show it as a per-session badge.

## Two layers, rules first

1. **Rules** decide the common cases and always win. A failure, a comment, a
   requested-changes review, a subscription error, or an open prompt is
   `needs_you`; a passing-check wake that made no tool calls is `waiting`; a
   deliberate done release is `ready`; an ordinary turn is `idle`.
2. **A decision model** classifies the one ambiguous case: a wake that was
   informational but where the agent still did something. Did it report
   something worth reading, or was the turn a no-op?

PR text is attacker-writable, so the rules own everything that matters and a
model can only ever answer the ambiguous middle. The model path never blocks a
turn (it answers after settlement), never calls a chat model, and fails loud: a
timeout, a refused request, a missing answer, or no configured model at all is
`needs_you` — a sound, never silence.

## Configuration

Under `attention` in `~/.pi/agent/settings.json` and `.pi/settings.json`:

```json
{
  "attention": {
    "enabled": true,
    "models": [
      "openrouter/typesafe/jev-1.14",
      "openrouter/microsoft/microsoft-decision-1.1"
    ],
    "timeoutSeconds": 2.5,
    "needsYouAt": 0.5,
    "nothingToDoAt": 0.85,
    "log": true
  }
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Off means no decisions and no events at all. |
| `models` | Jev 1.14, then Microsoft Decision 1.1 | Ordered cascade. Empty means rules only. |
| `timeoutSeconds` | `2.5` | Per model, before falling through. |
| `needsYouAt` | `0.5` | Probability at or above which a turn needs you. |
| `nothingToDoAt` | `0.85` | Probability "nothing to do" needs before a turn may be silent. |
| `log` | `true` | Append a verdict record per decision. |

Models are pinned on purpose. An alias like `jev-latest` can move to a new model
without anyone watching this extension's answers. A pinned id that the provider
retires is treated as an error and falls through the cascade; a spec that does
not resolve is an error too, not an excuse to use a different model.

The cascade goes through pi's classifier registry (`ctx.modelRegistry.classify`)
and the OpenRouter key in `~/.pi/agent/auth.json`. No separate client, no API
key of its own. A call costs about $0.00002 and takes about a second, and only
runs for wakes the rules could not settle.

## Verdict log

`~/.pi/agent/attention.jsonl` (`PI_ATTENTION_LOG` overrides the path), one JSON
line per decision with the compact inputs (the wake summary and the agent's last
message), the answers, the model, the latency, and the error when there was one.
It holds the agent's last message, so treat it as a session artifact rather than
something to publish. Past 1 MB the file keeps its newest half. `/attention log`
prints the tail.

The log is the input to a real calibration pass: replay recorded states through a
candidate cascade, compare thresholds against what actually happened, and only
then trust `nothingToDoAt`. That measurement is not built yet — see the follow-up
issue, along with the `notify` mapping.

## What sounds does with it

When this extension is loaded, `sounds` stops playing `Stop`/`AgentSettled` and
plays the state instead: `needs_you` gets a distinct cue, `ready` its own generated cue (`ready_to_merge.wav`),
`idle` keeps the old finished sound, and `waiting`/`working` are silent. That is
what turns the string of identical sounds into "this one is done" versus "this
one was nothing". Set `sounds.attention: false` to keep the old double cue.

## Ownership

`pi-attention` announces itself (`pi-attention:ready` plus a flag in
`globalThis`) so `sounds` can hand over the settle cue no matter which extension
loads first, and withdraws the announcement when it is turned off or quits.

## Files

| File | What it is |
| --- | --- |
| `index.ts` | Event wiring, `/attention`, publishing `AttentionChanged` |
| `state.ts` | The rule layer: which turn states need no model |
| `model.ts` | Questions, prompt-free state, and the probability thresholds |
| `config.ts` | `settings.attention` parsing and validation |
| `log.ts` | JSONL verdict log, rotation, and `/attention log` output |
| `types.ts` | States, turn facts, verdict records |

Classifier resolution and the cascade live in
[`_shared/classifier.ts`](../_shared/classifier.ts), shared with
[`permissions`](../permissions/), whose auto reviewer was switched onto the same
seam.

`pnpm check` and `pnpm test` cover it; every test injects the model answer or
the log sink, so none of them touch OpenRouter or your home directory.
