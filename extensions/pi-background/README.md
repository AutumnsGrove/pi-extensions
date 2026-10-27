# pi-background

Long shell commands that keep running after the tool call returns.

Claude Code's background-command flow, reduced to pi's primitives: a foreground
command streams normally, and if it is still running when the deadline passes it
moves to the background instead of being killed. The agent gets an id, keeps
working, and a `<task-notification>` arrives when the job exits.

```
● Background (2 running)
├─ ● b7f3k9a2x1  2m14s  pnpm build
│  └─ webpack 5.91.0 compiled successfully in 134217 ms
✓ b8a1m0p3q7  12.4s  pnpm test · completed
```

## Why not just install `pi-patty-bg-tasks`?

[`pi-patty-bg-tasks`](https://pi.dev/packages/pi-patty-bg-tasks) is excellent and
much larger: subagents, monitors, websocket sources, stall detection, typed job
kinds, and a 6.9k-line codebase. [`pi-bg-tasks`](https://pi.dev/packages/pi-bg-tasks)
is the same idea at ~1.7k lines. `pi-background` is the primitive this repo
actually wants: **shell jobs only**, a model-facing `jobs` tool, a compact
widget, and no new concepts beyond Claude's `run_in_background`.

## What the model sees

The built-in `bash` tool is replaced with the same rendering and two additions:

| Parameter | Effect |
| --- | --- |
| `run_in_background: true` | Start detached immediately and return the job id. |
| `timeout` | Seconds before the command is moved to the background. Defaults to 120. `sleep` is killed instead. |

When a command is backgrounded, the tool result contains the id, the log path,
and the next command to run:

```
Command running in the background with ID: b7f3k9a2x1
Output: /tmp/pi-bg/b7f3k9a2x1.log
Use jobs({ action: "output", id: "b7f3k9a2x1" }) to peek, "attach" to wait, or "kill" to stop it.
```

The `jobs` tool has six actions:

| Action | Params | Effect |
| --- | --- | --- |
| `list` | — | Running and finished jobs, with ids, status, elapsed time, and command. |
| `output` | `id`, optional `lines` | Last N lines plus the full log path. Reading a finished job marks it read. |
| `attach` | `id`, optional `timeout` | Wait for completion (default 120s, max 600s), streaming the tail. |
| `kill` | `id` | Stop the process group. |
| `search` | `pattern` | Regex search across the last 4MB of every job log. |
| `clear` | — | Drop finished jobs from the list. |

Prompt guidelines tell the model to use `run_in_background` for dev servers and
watches, to `attach` instead of `sleep`-polling, and to check an existing job
rather than re-running the command.

## What you see

- **Widget above the editor** — running jobs with elapsed time, the newest
  job's last output line, and recently finished jobs. Finished jobs fade out
  after 30 seconds (tunable with `PI_BG_WIDGET_TTL`); they stay in `jobs list`
  for 10 minutes (or until `/bg clear`), the same split pi-tasks uses for its
  panel and `/todos`. The widget disappears when there is nothing left to show.
- **Completion notification** — when a background job exits, a cleaned tail is
  delivered as a `<task-notification>`. The agent can react immediately, even
  mid-turn. Each job notifies exactly once; reading a finished job suppresses
  the pending message. While `pi-q-n-a` is waiting for an answer the
  notification is queued instead: waking the agent behind a question made it
  keep working while the user was still deciding. The queue flushes when the
  form closes.
- **`Ctrl+Shift+B`** — move the current foreground command to the background.
  Pi reserves `Ctrl+B` for cursor-left, and tmux owns it as a prefix, so the
  shifted chord is the portable choice. Detaching is refused while a question
  is open, since the completion would only be queued behind it.
- **`/bg`** — list jobs. `/bg <id>` shows recent output, `/bg detach` moves
  the running foreground command to the background (a tmux fallback when the
  chord is swallowed), `/bg kill <id>` stops one, `/bg clear` drops finished
  jobs, `/bg help` prints the mini manual.

## How it works

- A job is a detached `child_process.spawn`, not a thread or a tmux session.
  stdout and stderr are wired straight to a file descriptor at
  `<tmpdir>/pi-bg/<id>.log`; the kernel moves the bytes and the extension does no
  work while a background job runs.
- Foreground output is read back from the log every 150ms and forwarded to pi.
  When the deadline passes, the same process simply keeps writing to the same
  fd; the tool call returns its partial output and the job id.
- Auto-backgrounding is wall-clock based, not output-idle based. A compiler can
  be silent for minutes and still be healthy; treating silence as a stall would
  detach real work for no reason.
- Exit detection listens on `exit`, not `close`. A daemonized grandchild that
  inherited the log fd must not keep a finished job open forever.
- The registry lives on `globalThis`, so `/reload` keeps running jobs. Quitting,
  switching, resuming, or forking a session stops the jobs owned by that
  session; logs stay on disk for the OS to clean.
- Output is capped at 128MB per job. A job that exceeds it is stopped with a
  `reason` the model can see.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `--bg-timeout <seconds>` | `120` | Auto-background deadline for commands without an explicit `timeout`. |
| `PI_BG_TIMEOUT` | — | Same, when the flag is absent. |
| `PI_BG_LOG_DIR` | `<tmpdir>/pi-bg` | Where job logs are written. |
| `PI_BG_WIDGET_TTL` | `30` | Seconds a finished job stays in the widget. |
| `PI_BG_RETENTION` | `600` | Seconds a finished job stays in `jobs list` before it is pruned. |
| `PI_BG_SHELL` | `/bin/bash` (or `$SHELL`) | Shell used for jobs. |

## Limits

- POSIX-first. Windows falls back to `bash.exe` when available; process-tree
  killing uses `process.kill(pid)` rather than a process-group signal.
- At most 16 background jobs at once. Foreground commands do not count.
- Jobs do not survive a clean pi exit: `session_shutdown` stops them. A hard
  crash can leave a detached process running with no registry entry; the log
  file remains under the log directory so it can still be inspected.
- No subagents, monitors, websockets, or PTY sessions. Use
  `pi-patty-bg-tasks` if you want those.

## Testing

```bash
pnpm test -- extensions/pi-background
pnpm check
```

The registry tests spawn real `/bin/bash` processes with a temporary log
directory, so they cover the fd capture, tailing, kill path, auto-detach, and
sleep-timeout behaviour end to end.
