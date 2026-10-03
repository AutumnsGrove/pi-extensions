# thinking-box

Collapsible, timed thinking traces for [pi](https://github.com/earendil-works/pi).

Thinking no longer floods the transcript. It streams into a short box that
shows how long the model has been thinking and how many reasoning tokens it
has spent, and it opens to the full trace on demand.

```
─── ▸ Thinking for 12s, ~3.4k tokens ───────────────────────────── ctrl+o to expand
  …so the failing test is probably the timestamp comparison. Let me check whether
  the key includes responseId, because two messages in the same millisecond would
  collide otherwise. I should also confirm the session entry survives a reload.
────────────────────────────────────────────────────────────────────────────────────
```

Press **Ctrl+O** (pi's *expand tool output* action, which this extension also
drives) to expand every box to the full trace. The keybinding is shown as a
right-aligned hint on each collapsed box; press it again to collapse.

```
─── ▾ Thought for 20s, 15k tokens ──────────────────────────────────────────────────
  …so the failing test is probably the timestamp comparison. Let me check whether
  ... (the complete thinking trace, rendered by pi exactly as before)
```

## Usage

Nothing to enable — it is on in the interactive terminal.

| Action | Effect |
| --- | --- |
| `Ctrl+O` | Expand/collapse every thinking box (also expands tool output). |
| `/thinking-box` | Toggle expansion without touching tool output. |
| `/thinking-box expand` \| `collapse` | Set expansion explicitly. |
| `/thinking-box on` \| `off` | Enable/disable the extension for this session. |
| `/thinking-box lines <n>` | Preview height in lines (default `8`, max `50`). |

When expanded, the body is pi's own rendered thinking Markdown, so it looks
exactly like the built-in trace. Only the header line is added.

## What the header shows

- **Duration** is measured from the first thinking token to the last token that
  actually changed the trace, so a pause while the model streams ordinary text
  is not counted.
- **Tokens** come from provider usage (`usage.reasoning`) when the provider
  reports it. Otherwise they are estimated at ~4 characters per token and shown
  with a `~`.
- The verb changes from **Thinking** while streaming to **Thought** once the
  message ends.

Stats are persisted as a `thinking-stats` session entry (never sent to the
model), so they render correctly after scrolling, theme changes, and session
resume.

## How it works (and the caveat)

Pi has **no public renderer hook for assistant thinking blocks** — only custom
messages and custom entries can register renderers. This extension therefore
patches the exported `AssistantMessageComponent` prototype once, wrapping
`updateContent` and adding a `setExpanded` method so pi's existing Ctrl+O
machinery drives it.

This is safe on the binary pi ships because extensions resolve
`@earendil-works/pi-coding-agent` through pi's *virtual modules* to the same
bundled class the running app uses. Verified against pi `0.99.0`:

```json
{ "importedIsBundled": true }
```

The patch is defensive:

- It is installed once and survives `/reload` because state lives on
  `globalThis`.
- `updateContent` falls back to pi's original implementation if the layout it
  expects is missing, and any replacement error is swallowed so a pi change can
  never break a turn.
- In non-interactive modes (`print`, `json`, `rpc`) it stays dormant.

If a future pi release adds a first-class thinking renderer, this extension
should be rewritten to use it. See [`PLAN.md`](PLAN.md) for the full reasoning.
