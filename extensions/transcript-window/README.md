# transcript-window

Keep pi's rendered transcript bounded so long sessions stay responsive.

```
/window            # toggle the window
/window 100        # keep the last 100 chat items
/window off        # render the whole transcript again
/window status     # show the current setting
```

## Why

Pi keeps every message and tool result in its chat container. The main-screen
TUI re-renders that container and diffs every line on each frame, so the work
per keystroke or streaming token grows with the whole transcript. Sessions with
hundreds of tool calls therefore get sluggish, especially while scrolling.

This is a known pi limitation, not an extension mistake:

- [pi#9807 — full re-render causes scroll/typing lag](https://github.com/earendil-works/pi/issues/9807)
- [pi#7082 — O(viewport) transcript rendering proposal](https://github.com/earendil-works/pi/pull/7082)

The durable fix belongs in pi's renderer (viewport windowing / committed-prefix
diffing). `transcript-window` is a local workaround: it renders only the
trailing chat components and hides the rest behind a one-line marker.

## How it works

1. Capture the live TUI through a temporary widget factory. Widget factories
   receive the real TUI object; the placeholder widget is removed immediately.
2. Walk the component tree to the chat container (the document container's
   chat child, in both regular and fullscreen modes).
3. Replace the chat container's `render` with a windowed version. It renders
   only the last `maxItems` components. Older components stay in memory and in
   the session file; they are just not drawn.
4. When the window shifts, pi's normal full-redraw path clears the terminal
   scrollback and writes the new tail, so old lines disappear from the
   terminal as well as from pi's internal transcript.

Only the *rendered* transcript is limited. Model context, compaction, `/tree`,
`/fork`, exports, and the JSONL session file are untouched.

### Why components, not lines

A line-based window would drop one visible line for every new line and shift
the whole window on each frame, which forces a full scrollback redraw per frame.
A component-based window stays stable while a message streams and only shifts
when a new message or tool call is appended. That is the difference between a
full redraw once per item and a full redraw once per token.

## Settings

Stored at `<agent-dir>/transcript-window.json`:

```json
{
  "version": 1,
  "enabled": true,
  "maxItems": 100
}
```

- `enabled` — whether the window is active.
- `maxItems` — trailing chat components to render. Default `100`, minimum `4`.
  `0` is accepted by the config reader as "unlimited"; use `/window off` to
  disable the extension entirely.

The default keeps a substantial amount of history visible — roughly fifty tool
calls plus messages — while still stopping the transcript from ballooning into
the thousands. Each component can be several lines, so this is usually many
screens of scrollback. Use `/window 40` if you want Claude Code's much shorter
window.

## Marker

When older items are hidden, the top of the transcript shows a dim line:

```
⋯ 163 earlier items hidden · /window 100 · /session for the full log
```

`/session` prints the session file path. The full transcript can also be opened
with `pi --resume` or by reading the JSONL file directly.

## Modes

- **Regular mode** (default) — pi owns the terminal's normal scrollback. The
  window clears old scrollback via a full redraw and then writes only the tail.
- **Fullscreen mode** — the transcript scroll view is built from the same
  document, so it also only contains the tail. The window becomes the limit of
  what can be scrolled inside pi.

Terminal support for clearing scrollback varies. `transcript-window` still
reduces pi's own rendering work even if the terminal keeps old lines; exiting
and resuming a session starts with only the window rendered.

## Caveats

- This is a display optimization, not a memory cap. Old components remain in
  memory so `/window off` can restore them instantly.
- It relies on pi's internal component tree shape. Both the TUI capture and the
  chat-container lookup are defensive; if a future pi version changes them, the
  extension becomes inert instead of crashing.
- The marker is part of the rendered transcript but not the session. It is not
  exported and is never sent to the model.
- `pi-scroll-lock` solves a different problem (freezing the screen while the
  agent streams); the two can be used together.

## Root fix

If you want this upstream, the relevant pieces are:

1. A viewport-aware transcript container that only lays out visible children.
2. A committed-prefix diff so stable lines above the viewport are not rescanned.
3. Dirty-flag memoization in `Container.render` that returns the same array
   reference when nothing changed.

Until then, `/window` is the smallest useful intervention.

## Related extensions

- [`pi-scroll-lock`](https://pi.dev/packages/pi-scroll-lock) freezes the screen
  so new output does not yank you back to the bottom. It does not reduce the
  amount pi renders.
- [`pi-render-cache`](https://pi.dev/packages/pi-render-cache) memoizes
  `Intl.Segmenter` and Markdown rendering during streaming. It helps the
  per-frame constant factor but still walks the whole transcript.

`transcript-window` changes the amount of transcript in the render path, so it
can be combined with either.
