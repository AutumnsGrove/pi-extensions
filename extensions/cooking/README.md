# cooking

A steady activity glyph in the terminal tab title, so a background pi session
reads at a glance instead of making you switch to it. The marks are static, not
animated — one glyph per state, which stays calm when several sessions are open.

```
∞ - auth-refactor - pi-extensions      pi is working
◌ - auth-refactor - pi-extensions      pi is waiting on a dialog or approval
⁇ - auth-refactor - pi-extensions      the pi-q-n-a tool is asking you something
π - auth-refactor - pi-extensions      idle, pi's own title
```

## Usage

Always on. `/cooking` toggles it, and `/cooking on|off` sets it explicitly.

## How it works

Pi's tab title is `π - <session> - <cwd>`. Rather than prefixing a spinner
(`⠹ π - …`), this extension swaps the **app glyph slot itself**: the leading
`π` becomes `∞` while an agent run or compaction is in progress, then settles
back to `π` when idle. Nothing else about pi's title changes.

| State | Glyph | When |
| --- | --- | --- |
| working | `∞` | an agent run or context compaction is in progress (including retries and queued continuations) |
| waiting | `◌` | a blocking dialog or approval needs you (`ui_prompt_start`) |
| asking | `⁇` | the `pi-q-n-a` tool is open and waiting on your answers |
| idle | `π` | everything else |

The marks are distinct on purpose: active work, a blocked prompt, and a
questionnaire are three different reasons to look at the tab, and the earlier
Claude Code bug where an idle session's spinner never stopped is exactly the
confusion this avoids. They are also held still: with three pi instances
running, seven rotating glyphs per tab is a lot of motion for no extra
information. A frozen mark means a frozen pi.

State changes are driven entirely by events, so there is no timer: `∞` appears
on `agent_start`, `◌` on `ui_prompt_start`, `⁇` while `pi-q-n-a` is in flight,
and the title returns to `π` on `agent_settled`. Compaction is watched through
the session events (`session_before_compact` →
`session_compact`/`session_compact_failed`) so a manual `/compact` shows work
too.

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

- `WORKING_GLYPH` — the working mark, currently `∞`. `π` is deliberately not
  used, so a run never looks idle.
- `WAITING_GLYPH` — the dialog/approval mark (try `⧗`, `◔`, `⊘`).
- `ASKING_GLYPH` — the pi-q-n-a mark, currently `⁇`. `?` is the most widely
  rendered fallback; `✎`, `☑`, or `‽` also work.
- `DEFAULT_APP_TITLE` — must match pi's app title (`π` on a stock install).

## Caveats

- The extension reconstructs pi's title as `π - <session> - <cwd>`, reading the
  session name live via `session_info_changed`. A custom `piConfig.name` would
  change pi's own prefix; set `DEFAULT_APP_TITLE` to match.
- The marks are static. A tab that shows `∞` while pi is blocked on a prompt
  would mean a missed `ui_prompt_start`, but the events are paired, so in
  practice a non-`π` glyph always tells you pi is doing something.
