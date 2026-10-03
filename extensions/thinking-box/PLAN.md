# Plan: thinking-box

## Why

Long thinking traces are useful but consume the transcript. When a lot of
reasoning streams in it can fill the whole visible viewport, hiding the work
that is actually being done (tool calls, results, progress). The desired
behaviour, Claude Code style:

- Show thinking as a short box (default ~8 lines) that streams live.
- Expand to the full trace on a keypress.
- Label each block with how long it thought and how many tokens it used.

## What pi gives us

Investigated against pi `0.99.0` / `0.99.2`:

- `AssistantMessageComponent` (in `dist/modes/interactive/components/`) renders
  assistant messages, including thinking. It has `hideThinkingBlock`,
  `thinkingVisibilityOverrides`, `setHideThinkingBlock`, `setHiddenThinkingLabel`
  and `updateContent`, but **no public renderer hook**.
- `ExtensionAPI` only exposes `registerMessageRenderer` (custom messages) and
  `registerEntryRenderer` (custom entries). There is no assistant/thinking
  renderer.
- `app.tools.expand` (`Ctrl+O`) calls `setToolsExpanded`, which walks
  `chatContainer.children` and calls `setExpanded(expanded)` on anything where
  `isExpandable()` is true (`typeof obj.setExpanded === "function"`). So adding
  `setExpanded` to a component makes pi's own keybinding drive it, including the
  re-render (`showStatus` → `requestRender`).
- `app.thinking.toggle` (`Ctrl+T`) calls `setHideThinkingBlock` on each
  assistant component.
- Extensions resolve `@earendil-works/pi-coding-agent` through pi's virtual
  modules. In the shipped CLI, `isBundledNode` is `true`, so the loader passes
  `virtualModules` and the extension receives the **same class object** the
  running app uses. Verified with a probe extension:
  `importedIsBundled: true`.
- `AssistantMessageComponent` is a public export, and `MouseRegion.child`
  (the rendered thinking component) is reachable at runtime.
- The assistant message exposes `timestamp` and `usage.reasoning`; the final
  message is available at `message_end`.

## Decision

Patch the shared `AssistantMessageComponent` prototype once:

1. **`updateContent` wrapper.** Force `hideThinkingBlock = false` and clear
   `thinkingVisibilityOverrides`, call the original (so text, tool calls,
   errors, spacing and the fully-rendered thinking Markdown are all pi's),
   then replace each thinking `MouseRegion` with a `ThinkingBox`. The original
   inner Markdown is reused as the expanded body, so expanding looks exactly
   like the built-in trace.
2. **`setExpanded`.** Adds the method pi's Ctrl+O looks for. It stores the
   state on the component and on a shared global, then re-runs `updateContent`.
   New boxes inherit the global state, so a box created mid-stream matches the
   current mode.
3. **`ThinkingPreview`.** Collapsed body. Uses `truncateToVisualLines` to clip
   the tail to N visual lines at the real terminal width, styled with the live
   theme. Shows an `…` marker when earlier lines are hidden.
4. **`ThinkingBox`.** Renders a top rule with the header label on the left and
   the expand keybinding right-aligned, the body (preview or full Markdown), and
   a closing rule when collapsed.

State lives on `globalThis` because `/reload` re-evaluates the module while the
prototype patch (and its closure) survives.

Stats are tracked in `stats.ts` (pure, unit-tested):

- `ThinkingStatsTracker.observe` runs the clock from the first thinking token to
  the last token that changed the trace, and caches the final result by message
  key.
- Tokens prefer `usage.reasoning`; otherwise estimated at ~4 chars/token and
  flagged for a `~` in the header.
- `message_end` appends a `thinking-stats` custom entry; `session_start` seeds
  the tracker from the branch so resumed sessions re-render correct stats.

## Rejected

- **`registerMessageRenderer` / custom messages.** Thinking is not a custom
  message; converting it would drop pi's rendering and require reimplementing
  the assistant layout.
- **`registerMarkdownTransformer`.** Could inject a header and clamp lines
  (it receives `availableWidth`), but has no access to per-message timing/usage
  or the component's expand state, and cannot trigger a re-render on toggle.
- **A widget near the editor.** Would not be inline in the transcript, and the
  built-in thinking would still render in full unless globally hidden — which
  the extension cannot set through a public API.
- **Fully reimplementing `updateContent`.** More code to keep in sync,
  duplicates spacing/error/markdown handling, and must be updated on every pi
  release. The wrapper reuses pi's output instead.

## Risks

- Tied to the internal shape of `AssistantMessageComponent` (0.99.x). Mitigated
  by the fallback path and by swallowing replacement errors.
- `Ctrl+O` expands tool output as well as thinking. That matches the requested
  "Ctrl+O expands everything" behaviour; `/thinking-box` toggles thinking
  independently.
- `Ctrl+T` (hide/show thinking) no longer has a distinct effect; boxes stay
  visible. Documented in the README.
