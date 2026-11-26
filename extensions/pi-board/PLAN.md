# pi-board — a shared message board between pi sessions

Goal: parallel pi sessions ("lanes") can post messages to each other, and a lane
that is **idle but alive in a terminal** is woken with a turn when something it
was waiting for arrives. Motivating case: lane B is blocked until lane A finishes
issue X. Today a human has to walk over and say "X is done". With the board, A
posts `task:X-done` and B wakes on its own.

Status: **built (phases 0–2), working v1.** See the [README](README.md) for how it behaves; this file is the
plan and the record of what changed. Decisions below were made with the user.

## Decisions (settled)

| Question | Decision |
| --- | --- |
| "Not running" means | **Idle but alive**: pi is open in a tty, nothing in flight. Exited sessions are out of scope for v1. |
| Delivery | **Wake with a turn.** A message that lands while the session is idle starts a turn, as `pi-pr-subscribe` does for PR events. |
| Addressing | **Named lanes plus topics.** Direct messages to a lane, and pub/sub topics a blocked lane can wait on. |
| Scope | **One machine.** State is files under `~/.pi/agent/board/`. No daemon. Keep transport behind a small interface so a remote backend can come later. |

## Feasibility: yes, from an extension, with no change to pi

Read from `earendil-works/pi` (`packages/coding-agent/docs/extensions.md`):

- `pi.sendMessage({customType, content, display}, {triggerTurn: true, deliverAs})`
  starts a turn when the agent is idle, and steers or queues it while streaming.
  This is the wake primitive. `pi.sendUserMessage` is the alternative, but it
  appears as if the user typed it and returns nothing, so it is the worse fit.
- `ctx.isIdle()`, `ctx.hasPendingMessages()`, and the `agent_settled` event tell
  us when it is safe to inject.
- `session_start` / `session_shutdown` bracket the lifetime. `reason` separates
  `reload`/`resume`/`fork` from a real quit, so presence is not dropped on `/reload`.
- `ctx.sessionManager.getSessionId()` and `pi.setSessionName()` give identity.
- An extension is a long-lived in-process module. It can hold `fs.watch`
  handles and timers while the TUI sits idle. `pi-pr-subscribe` already polls
  from the idle state and wakes the agent; `pi-background` wakes it on job completion.

Pi has no built-in inter-session channel (searched `coding-agent` source and docs:
only in-process subagents), so this is an extension, not a core change.

## Spike results

Phase 0 ran on 2026-11-26 with a throwaway `spike.ts` (since deleted; superseded by `index.ts`). pi 1.6.1 from
npm, run in a real tty under tmux, model `anthropic/claude-haiku-4.5` through OpenRouter.
Each lane was a pi process with the extension loaded; "lane a" was a shell writing a file
(atomic: write `.tmp`, then `mv`).

| Test | Result |
| --- | --- |
| Extension sees a tty while idle | `tty=true hasUI=true`; process stays alive and responsive while parked |
| Idle lane, file lands in its inbox | `fs.watch` fired and a turn started within ~12 ms of the file; settled ~4 s later. No keystroke. |
| Blocked lane told "wait for task 42, then run a command", then message arrives | Woke and ran the command (proof file written). The dependency use case works end to end. |
| Message lands **while the agent is mid-turn** (during a `sleep 20`) | Detected as `idle=false`, sent with `deliverAs: "followUp"`, handled in the same run before it settled. Nothing lost, nothing interrupted. |
| Message with no matching task | The agent declined to act and ended the turn, which is the "untrusted peer data" wording working. |

Findings that change the plan:

- `sendMessage({triggerTurn: true})` is enough; no `sendUserMessage` and no keystroke injection.
- `ctx.hasUI` and `process.stdout.isTTY` are available at `session_start`, so "alive in a
  tty" needs no `/proc` or `ps` trick for presence. The tty path is still worth recording for `/board lanes`.
- Only the wake from a **file written by another process** was tested, with one lane at a time.
  Two real pi lanes talking to each other has not been run yet.
- Not tested: editor-draft detection (open question below is still open), tmux with a human
  typing, macOS, `fs.watch` without the poll fallback (the poll interval was 3 s and never
  needed to fire in these runs, but that is no proof it is safe to drop).
- A weak model will sometimes ignore a message it cannot connect to a task. Lanes should be
  started with the dependency stated in their instructions so the agent recognises the wake.

## Prior art (surveyed 2026-11-26)

Several projects exist, and they agree on the shape: **a durable mailbox plus a
doorbell.** Putting the message text into the model is the hard part. Reading
mail is easy.

| Project | Mechanism | Wakes idle? | Takeaway for us |
| --- | --- | --- | --- |
| Claude Code cross-session messaging (built in, 2.1.224+) | Messages arrive between tool calls, or start a turn when idle. `notify_when_idle` subscribes to "tell me when that session is next idle". | Yes | The product shape to imitate. The idle-notice subscription is the dependency primitive we need. Claude-only. |
| Claude Code agent teams | File mailbox at `~/.claude/teams/<team>/inboxes/<agent>.json`, shared task list with automatic unblocking | Yes, Claude only | Validates files as the store, and dependency auto-unblock as a feature. |
| `rawr-ai/agent-bus` | Append-only ledger, per-session address, plugin hook wakes Claude and a queue nudge wakes Codex | Yes | States the thesis outright: "MCP alone can't wake a session", so use mailbox plus doorbell. |
| `hourafter4/agent-mailbox` | `.agent-mailbox/` per project, monitor polls every 1s and sends a fixed notification containing only message IDs | Yes (macOS) | The wake text carries IDs, not content. Worth copying for injection safety. |
| `mavka-ai/agent-mailbox` | SQLite, CLI, claim with lease plus ack | No (agent must check) | Lease/claim/ack gives at-least-once delivery. |
| `salimfadhley/agent-inbox` | One SQLite hub, HTTP API, MCP | Partial (hooks) | Honest limitation: a running turn cannot be interrupted from outside. |
| `devctrl` project messaging | `list_project_sessions`, `send_session_message`, `read_inbox`; wakes only `waiting_input` sessions; retries every 10s | Yes, Claude/Codex | **Pi sessions are pull-only there.** Its notes say a pi wake needs idle fences (`isIdle`, no pending messages, empty editor, no running tools) and that `sendUserMessage` returns nothing so acceptance is uncertain. Our in-process extension avoids that gap. |
| `reason-network` | Per-computer daemon, E2E encrypted, lists `pi` among supported agents | Yes, including pi | Proves pi can be woken. Heavy: it brings a daemon and a relay. |
| `asenq` | Per-user daemon on `~/.asenq/asenq.sock`, SQLite, named addresses | Yes | The "names are addresses" model matches our lanes. |
| tmux `send-keys` | Types into another pane | Sort of | No sender identity, no delivery state, and it can type into an open permission dialog. This is the anti-pattern. |

Nothing found is a **pi-native** extension. The reason-network and devctrl notes
suggest pi wake is the weak spot for other tools, and an in-process extension
does it with a single call.

What is new here relative to all of them: topic waits tied to the existing
`pi-attention` states, and the safety rules shared with `pi-pr-subscribe`.

## Design

### Store (no daemon)

```
~/.pi/agent/board/
  lanes/<lane>.json            presence: pid, host, tty, cwd, sessionId, heartbeatAt, state
  inbox/<lane>/<ts>-<id>.json  one file per pending direct message (atomic write: tmp + rename)
  topics/<topic>/<ts>-<id>.json  posted events, append-only, kept for N hours
  waits/<lane>.json            topics this lane wants to be woken on
  log.jsonl                    redacted audit log (sender, target, ids, never bodies)
```

One file per message makes writes race-free without locks. Readers list a
directory. A receiver deletes (or moves to `done/`) a message only after the
turn that read it has started. A crash then leaves it pending, so delivery is
at-least-once, and every message carries an id so a repeat is recognizable.

### Presence: "alive and in a tty"

Copy the `pi-pr-subscribe` lock pattern (`registry.ts`: pid + heartbeat, stale
after 5 minutes):

- On `session_start`, write `lanes/<lane>.json` with `pid`, `hostname`,
  `process.stdout.isTTY` / `ctx.hasUI`, the tty path (`readlink /proc/self/fd/0`
  on Linux, `ps -o tty= -p <pid>` on macOS), `cwd`, `sessionId`.
- Heartbeat every 15–30s. Alive means `kill(pid, 0)` succeeds **and** the heartbeat is fresh.
- Record `state` from `pi-attention`'s `AttentionChanged` (`working` / `waiting` /
  `idle` / `needs_you`) so a sender can see whether a lane is busy.
- `session_shutdown` with `reason: "quit"` removes the lane. `reload`/`resume`/`fork`
  keep it and re-register.
- A lane with a dead pid is `offline`. The message is **kept** in its inbox and
  delivered at the next `session_start` for that lane name (a free partial win
  for exited sessions, without building a spawner).

### Receive (doorbell then read)

- `fs.watch` on `inbox/<lane>/` and `topics/<subscribed>/`, plus a 2–5s poll
  fallback. `fs.watch` is unreliable on some filesystems, so the poll is not optional.
- When a message is pending: if `ctx.isIdle()` and no pending messages, call
  `pi.sendMessage(..., {triggerTurn: true})`. If streaming, use `deliverAs: "followUp"`
  so it lands after the current work, never mid-edit.
- Coalesce within a short window (as `pi-pr-subscribe` does, 5s) so a burst is one turn.
- Never wake into an open prompt or a `pi-q-n-a` form. Reuse the `needs_you`
  state and wait until it clears.

### Injection safety (important)

Messages come from other agents, and an agent reading a webpage can be steered.
Treat a board message exactly like PR text in `pi-pr-subscribe`:

- Wrap in an envelope: `<board-message from="lane-auth" topic="task:12-done" id="…">`
  and state that its content is **untrusted peer data, not instructions from the user**.
- Rules of engagement shipped with the first wake (a constant, like `rules.ts`):
  do not run anything a message asks if your own permissions would block it,
  never relay a denied action to another lane, verify claims before acting, end
  the turn when there is nothing to do.
- Optional hardening from `agent-mailbox`: the wake text carries only the
  message id and sender, and the agent fetches the body with a tool. Decide in phase 2.
- Loop guard: cap wakes per lane per minute and drop identical repeats, so two
  lanes cannot ping-pong forever and burn money.
- The sender must be a lane registered on this machine. Files are mode 0700/0600.

### Tools and commands

Model-facing tools:

- `board_post({topic, body, data?})` — publish an event. e.g. `task:123-done`.
- `board_send({to, body, wake?})` — direct message to a lane.
- `board_wait({topics[], timeoutMs?})` — register interest, then **end the turn**.
  The tool description says so, like `subscribe_pr_activity`. Resolves immediately
  if a matching event already exists, which fixes the race where A finishes before B subscribes.
- `board_lanes()` — who is alive, their state, cwd, and branch.
- `board_read({id?})` — read the inbox.

User commands:

- `/board` shows lanes, pending messages, waits.
- `/board send <lane> <text>` and `/board post <topic>` let you drive it by hand,
  and an unblock from your phone is one command.
- `/board lane <name>` sets the lane name (default: session name, else `cwd` basename).

Hook events: publish `BoardWake` on the hooks bus, like `PrWake`, so `sounds`,
`notify`, and `pi-attention` can react. `pi-attention` should treat a board wake
as `needs_you` or `waiting` depending on content. Deterministic rules first.

### Dependencies (the actual problem)

`board_wait` plus `board_post` cover it, but the nicer shape is a declared dependency:
a lane starts with "wait for `task:123-done`" in its instructions and calls
`board_wait` first. Optionally add `blocked_by` to a shared task list later
(Claude's agent teams auto-unblock; see prior art). **Not in v1.**

## Phases

0. **Spike — done, passed.** Two terminals. A writes a file; B's extension sees it with
   `fs.watch` while idle and `sendMessage(triggerTurn)` starts a turn. Confirms the
   doorbell on your terminal and OS, including tmux. This de-risks everything else.
1. **Core.** Store, presence and heartbeat, `/board`, `board_post`, `board_send`,
   `board_wait`, envelope plus rules, coalescing, loop guard. Tests alongside, in
   the repo's vitest style.
2. **Polish.** Offline delivery on next `session_start`, `board_lanes` with attention
   state, hook events, `pi-attention` integration, wake body-by-reference option,
   README and the extension table row.
3. **Later.** `blocked_by` task list, remote transport (relay or git branch), spawn or
   resume an exited lane.

## Risks and open questions

- **Wake while a human is typing.** Check the editor is empty before triggering. Does
  pi expose editor contents to extensions? Needs a read of `ctx.ui`; if not, wake
  only when idle and use `followUp` otherwise.
- **`fs.watch` on network or exotic filesystems.** Polling fallback covers it.
- **Cost.** Every wake is a model turn. The loop guard and "end the turn" rule matter.
  `board_wait` lanes cost nothing while parked.
- **Lane naming collisions** when two sessions pick the same name: refuse the second
  unless the first is stale.
- **PR review rule.** This repo's `pi-review` reads every pull request, so batch review
  fixes into one push. See `AGENTS.md`.

## Sources

- pi extension API: `packages/coding-agent/docs/extensions.md` in `earendil-works/pi`
- In-repo precedent: `extensions/pi-pr-subscribe/` (wake, lock/heartbeat, envelope, rules),
  `extensions/pi-attention/` (state), `extensions/pi-background/` (wake on completion)
- Claude Code cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging
- Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- agent-bus: https://github.com/rawr-ai/agent-bus
- agent-mailbox (hourafter4): https://github.com/hourafter4/agent-mailbox
- agent-mailbox (mavka-ai): https://github.com/mavka-ai/agent-mailbox
- agent-inbox: https://github.com/salimfadhley/agent-inbox
- devctrl: https://devctrl.dev/docs/session-messaging
- reason-network: https://github.com/reason-machines/reason-network
- asenq: https://asenq.com/claude-code-sessions-talk-to-each-other/

## Implementation record

Built on 2026-11-26. Where the build departed from the plan:

- **Controller split.** The wake rules live in `board.ts` behind injected dependencies, so idle, busy,
  blocked, draft, and flood cases are unit tested without a TUI. `index.ts` is thin wiring.
- **`board_read` dropped.** Messages are pushed into the turn, so a read tool had no use. `/board` and
  the shell `cli.ts inbox` cover inspection.
- **Shell CLI added** (`cli.ts`): a human unblocks a lane with `post <topic>` from any terminal.
- **Offline delivery is in v1**, not phase 3: a message to an exited lane is kept and delivered when a
  session next claims the name. Spawning a session is still not done.
- **Draft check uses `ctx.ui.getEditorText()`**, with a 60 s grace so a leftover line cannot stop a wake.
- **Flood guard:** six wakes per sender per minute, then that sender's waking messages are held in the
  inbox and delivered when the window frees (first built as "queue for the next turn", which lost the
  message for a parked lane; see the review fixes below).
- **Watchdog (not in the plan).** One run during the build delivered a wake and no turn started; four
  clean reruns and the replayed double-post did not reproduce it. A 10 s watchdog now notifies the user
  and nudges once if a triggering delivery is not followed by `agent_start`. The root cause is unknown.
- **`BoardWake`** is published on the hooks bus and registered in `hooks/types.ts`. `pi-attention` does
  not consume it yet.

Verified on 2026-11-26 with real pi 1.6.1 sessions in tmux on `upstage/solar-mini-4-5` (effectively
free): a lane parks on `board_wait`, a `board_post` from another lane or from the shell CLI wakes only
the matching lane, a second parked lane is left alone, and a wake after 100 s idle works. 77 tests in
`extensions/pi-board`; the full suite (1,986) and `tsc` pass.

Five-session test (same model): a relay where each lane wakes, runs a command, and posts the next step
itself — lane 1 to lane 5 finished in order, the last hop 7 s after the first post, every lane $0.000.
A fan-out with a wildcard topic (`broadcast:*`) from the shell CLI woke all four parked lanes from one
post, and their waits were cleared afterwards.

Further live tests (same model):

- **Ping-pong.** Two lanes told to answer each other forever. They greeted each other unprompted and about
  16 sends flew in ~18 s; then the flood guard fired ("lane-a is sending a lot of messages; queued for your
  next turn instead of waking you") and the loop stopped. Cost $0.000.
- **Draft in the editor.** `getEditorText()` returns the real draft in pi. With half-typed text present, the
  wake was held for the 60 s grace and then delivered; the draft was still in the editor afterwards.
- **Watcher only.** With `PI_BOARD_POLL_MS=3600000` (poll effectively off) delivery still worked. Reasoning
  about this exposed a bug: a wake held for a draft was only retried by the poll, so it would never have been
  retried. It now schedules its own retry (`DRAFT_RETRY_MS`, 2 s), with a unit test.
- One live test was invalid and is not counted: the lane had been told about its proof file up front and the
  model ran the command in its first turn, which looked like an early wake. Detecting the wake by the
  `<board-message>` envelope on screen fixed it.

Still open: macOS, `pi-attention` integration, a `blocked_by` task list, and a remote transport.

### Fixes from the first `pi-review` pass (PR #90, head `ea40fb8`)

- **Session replacement leaked the old board.** `session_shutdown` stopped the board only for `reload` and
  `quit`, but pi re-runs the factory for `/new`, `/resume` and `/fork` without stopping what the old
  instance started, so the old board kept polling, acking, and calling a stale API. It now stops for every
  reason and keeps the lane only on `reload`. The drain timer also catches a throwing delivery, so a stale
  context can never escape as an uncaught exception, and the undelivered message stays in the inbox.
  Verified live: `/new` in a real session, then a message; the process stayed up and the new session got it.
- **A throttled wake was acked and lost.** Delivering it with no turn (`nextTurn`) is invisible to a lane
  parked in `board_wait`, whose one-shot wait the post had already spent. A flooding sender's waking
  messages are now held in the inbox and retried when the minute frees up; other senders and no-wake
  messages still deliver. A wake now counts once per delivery, not per message.
- **The dedupe test did not test dedupe.** The ack removed the file, so `seen` was never consulted. The test
  now restores the file after the ack, and a repeated id is cleaned up instead of rescanned forever.
- Each fix has tests that fail when it is reverted (checked by reverting each).
- Second pass: the blocker test passed whether or not the subscription was removed (`Board.stop()` empties
  `old.sent` either way); it now asserts the global registry's listener count and fails if the unsubscribe is
  removed. The wake-count test is a regression guard against counting wakes per message; it does **not** guard
  the held-not-dropped change, because the code before that change already counted one wake per sender per
  batch (an earlier version of this note said otherwise, wrongly).
