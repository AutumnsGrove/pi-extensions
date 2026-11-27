# handoff-flag

A one-line reminder that a `HANDOFF.md` is sitting in the repository root.

```
✓ HANDOFF.md · 3h
```

The [handoff skill](https://github.com/AutumnsGrove/pi-extensions) writes
`HANDOFF.md`, leaves it untracked, and tells the next reader to delete it. It is
easy to resume from one and then forget it is still there, so this extension
shows nothing more than its presence — and the line disappears the moment the
file is deleted.

## What it shows

| Part | Meaning |
| --- | --- |
| `✓` | The file exists at the repository root. The whole line is hidden when it does not. |
| `HANDOFF.md` | The filename, exactly. A nested `docs/HANDOFF.md` or a `handoff.md` in another directory does not count. |
| `3h` | How long ago it was last written: `<1m`, `42m`, `3h`, `2d`. Staleness is the useful part — a handoff from two days ago is probably no longer true. |

It renders on its own line just above the footer, the same slot `git-status`
uses, so it never competes for room on the extension status line.

## Refreshing

The widget refreshes after tools run, at the end of each turn, and after user
`!` shell commands. It also polls: one `stat` of one fixed path every two
seconds, so a file written or deleted from another terminal — or by an agent in
a different session — shows up or disappears within a couple of seconds without
waiting for an event.

The poll only repaints when the presence, the size, or the age bucket changes,
so an idle session costs a stat and no rendering.

## Command

| Command | Effect |
| --- | --- |
| `/handoff` | Report the file's age, size, and path, with the `rm HANDOFF.md` reminder — or say there is none. |
| `/handoff on` \| `off` | Show or hide the line for the session. |

Outside a TUI (`pi -p`, JSON, RPC) no widget is registered and nothing is
polled, but `/handoff` still reports the file's state when a slash command is
reachable, such as RPC mode.
