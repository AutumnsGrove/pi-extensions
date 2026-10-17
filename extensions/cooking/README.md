# cooking

A live activity glyph in the terminal tab title, so a background pi session
reads at a glance instead of making you switch to it.

```
∑ - auth-refactor - pi-extensions      pi is working (π morphs through math)
◌ - auth-refactor - pi-extensions      pi is waiting on a dialog or approval
⁇ - auth-refactor - pi-extensions      the pi-q-n-a tool is asking you something
π - auth-refactor - pi-extensions      idle, pi's own title
```

## Usage

Always on. `/cooking` toggles it, `/cooking on|off` sets it explicitly, and
`/cooking speed <ms>` tunes the frame time live (default 400 ms, clamped to
40–2000 ms). `/cooking speed` with no value reports the current setting.

## How it works

Pi's tab title is `π - <session> - <cwd>`. Rather than prefixing a spinner
(`⠹ π - …`), this extension animates the **app glyph slot itself**: the leading
`π` morphs through pi-flavoured math symbols while an agent run or compaction is
in progress, then settles back to `π` when idle. Nothing else about pi's title
changes.

| State | Glyph | When |
| --- | --- | --- |
| working | `∏ ∑ √ ∞ ∂ ∫ ≈` | an agent run or context compaction is in progress (including retries and queued continuations) |
| waiting | `◌` | a blocking dialog or approval needs you (`ui_prompt_start`) |
| asking | `⁇` | the `pi-q-n-a` tool is open and waiting on your answers |
| idle | `π` | everything else |

The marks are distinct on purpose: active work, a blocked prompt, and a
questionnaire are three different reasons to look at the tab, and the earlier
Claude Code bug where an idle session's spinner never stopped is exactly the
confusion this avoids.

Animation is a single timer that runs only while working (one frame every
400 ms by default). It starts on
`agent_start`, stops on `agent_settled`, and is cleared on `session_shutdown`.
Compaction is watched through the session events (`session_before_compact` →
`session_compact`/`session_compact_failed`) so a manual `/compact` animates
too. The working glyph is the only animated one; `◌` and `⁇` hold still so a
frozen tab means a frozen pi.

## Why not the built-in progress bar?

Pi already emits [OSC 9;4](https://terminfo.dev/extensions/osc9-progress-bar)
progress indicators on `turn_start` → `agent_end` when
**Settings → Terminal → Terminal progress** is on. That works in Ghostty,
iTerm2, WezTerm, Windows Terminal, Konsole and mintty — but **not in macOS
Terminal.app**, which is why a pi tab there shows nothing while pi works. A
title glyph is rendered by every terminal that shows a title, so `cooking` is the
Terminal.app answer. The two coexist: leave the built-in setting on for
terminals that support the bar, and this covers the rest.

## Tuning

The look lives in one place, [`spinner.ts`](./spinner.ts):

- `WORKING_FRAMES` — the morph cycle. `π` is deliberately not in it, so a run
  never looks idle.
- `WAITING_GLYPH` — the dialog/approval mark (try `⧗`, `◔`, `⊘`).
- `ASKING_GLYPH` — the pi-q-n-a mark, currently `⁇`. `?` is the most widely
  rendered fallback; `✎`, `☑`, or `‽` also work.
- `DEFAULT_APP_TITLE` — must match pi's app title (`π` on a stock install).
- `DEFAULT_FRAME_MS` in `index.ts` — the starting animation speed. One frame
  is 400 ms by default, so the seven-glyph loop takes ~2.8 s. `/cooking speed
  <ms>` overrides it for the session.

## Caveats

- The extension reconstructs pi's title as `π - <session> - <cwd>`, reading the
  session name live via `session_info_changed`. A custom `piConfig.name` would
  change pi's own prefix; set `DEFAULT_APP_TITLE` to match.
- `waiting`/`asking` are static marks. A tab that is not animating while pi is
  blocked is telling you that pi needs you, not that it stalled.
