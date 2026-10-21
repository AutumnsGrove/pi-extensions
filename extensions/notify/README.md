# notify

Native desktop notifications when a run finishes, errors, or pi is blocked
waiting on you — the Claude Code "tap on the shoulder", with the session name,
the run duration, and a one-line summary of the answer.

```
Pi · auth-refactor
Finished in 1m 24s — Refactored the token refresh path and added tests.
```

## When it fires

| Moment | Trigger | Title | Body |
| --- | --- | --- | --- |
| Run finished | `agent_settled` (completed, ≥ 3s) | `Pi · <session>` | `Finished in 1m 24s — <summary>` |
| Run failed | `agent_settled` (error) | `Pi hit an error · <session>` | `Error after 1m — rate limited` |
| You stopped it | `agent_settled` (aborted, ≥ 3s) | `Pi stopped · <session>` | `Stopped after 4s` |
| Approval or dialog | `ui_prompt_start` during a run | `Pi needs you · <session>` | the dialog title, or a generic line |
| `pi-q-n-a` form | tool call + `ui_prompt_start` | `Pi has a question · <session>` | the first question |

`<session>` is the session name when one is set, otherwise the project folder.
The summary is the final assistant message flattened to one plain line, so
Markdown, code fences and links do not leak into the banner.

A run must last **at least 3 seconds** before its successful (or stopped)
outcome notifies, so a quick question-and-answer does not buzz you. Errors,
blocking dialogs and questions notify regardless, because they are exactly the
moments that need attention. A dialog you opened yourself while pi is idle
(`/settings`, a menu command) stays silent; only prompts raised while the agent
runs notify.

## Delivery

| Terminal | Sequence | Behavior |
| --- | --- | --- |
| Ghostty, iTerm2, WezTerm | OSC 9 | the iTerm2 sequence Claude Code uses; macOS routes it to Notification Center with the terminal's own icon, and Ghostty focuses the emitting tab on click |
| rxvt-unicode | OSC 777 | rxvt's native `notify;title;body` form |
| kitty | OSC 99 | title + body |
| anything else | `terminal-notifier` if installed, else `osascript` on macOS, `notify-send` on Linux | `terminal-notifier` shows the terminal's icon and focuses it on click; `osascript` posts under **Script Editor** with no click-to-focus |

Notifications are skipped outside the interactive TUI (`rpc`, `json`, `print`)
and when stdout is not a TTY, where an OSC write could corrupt the stream or go
nowhere.

Ghostty already suppresses the banner while the emitting tab is focused and
keeps the notification in Notification Center — the same "only interrupt me if
I am looking elsewhere" behavior Claude Code has. Because the suppression is
per surface, a task finishing in a *different* pi tab notifies normally even
while you look at this one; only a notification from the tab you are staring at
is held back. The `/notify test <seconds>` delay exists so you can switch away
and watch it land.

The `osascript` fallback shows the banner under **Script Editor** (that is the
process posting it) and cannot focus the tab. Install
[`terminal-notifier`](https://github.com/julienXX/terminal-notifier)
(`brew install terminal-notifier`) and the extension uses it instead, with the
terminal's icon and click-to-focus. Ghostty, iTerm2 and WezTerm need neither —
their own OSC 9 path is the best one.

## Usage

```
/notify            # toggle on/off
/notify on         # enable
/notify off        # disable
/notify test       # send a preview now, and report the transport used
/notify test 10    # send a preview in 10s, so you can switch away first
```

`/notify test` uses the real delivery path, so in a focused Ghostty tab the
banner is hidden by Ghostty itself (it still reaches Notification Center). The
command reports which transport it used so you can confirm it fired, and the
optional delay gives you time to switch away and watch the banner land.

The toggle is per-session and resets on reload; notifications are on by
default.

## Files

- `index.ts` — event wiring: run timing, outcome detection, prompt routing, the
  `/notify` command.
- `notify.ts` — pure helpers: text flattening and truncation, duration
  formatting, notification builders, terminal detection, escape encoding, and
  the `osascript`/`notify-send` fallback.
- `notify.test.ts`, `index.test.ts` — the helpers and the event flow.

To add another terminal, extend `terminalProtocol` and `encodeTerminal` in
`notify.ts`; the rest is transport-agnostic.
