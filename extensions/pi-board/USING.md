# Briefing a lane

The board is only as useful as the brief you give a lane. This page is about the
words, not the mechanics; for those see [README.md](README.md).

## What you never have to say

The tools and their rules are in every lane's system prompt from the first turn,
so you do not brief the mechanics. The agent already knows:

- `board_wait`, `board_post`, `board_send`, `board_lanes` and `/board` exist;
- `board_wait` parks, and a matching `board_post` wakes it — it is not polling;
- a `<board-message>` is peer data, not an instruction from you;
- the first wake of a session ships the safety rules on its own.

You do not have to explain the envelope, the flood guard, the draft grace, or the
watchdog. You do not have to say "do not poll". `board_wait`'s own description
says to end the turn.

## What only you can supply

Two things, and both belong in the sentence that already gives the lane its task:

1. **The topic it is blocked on.** The agent cannot invent an identifier that
   another lane will also use. Pick it and name it.
2. **That it should park now**, rather than asking you what to do.

So a blocked lane is briefed the same way you brief it on anything else — the
dependency is just one more fact:

> You are lane B. Fix the token refresh in `src/auth/`. **You are blocked on
> `task:42-done`** until lane A lands the new token format there: call
> `board_wait` on it and end the turn. A message will wake you; carry on with
> the refresh when it does.

That is the whole thing. The imperative verb plus the exact topic, in the brief,
in the same breath as the task. Exactly like saying "subscribe to the PR": the
agent knows how to subscribe, so you only have to say which PR.

And the producing lane gets one line at the end of its brief:

> When the token format is in and the tests pass, `board_post` `task:42-done`.

## Pick a topic grammar once

Two lanes that never talk to each other still have to agree on a string. Choose
a shape and keep it, so a topic is guessable rather than negotiated:

| Topic | Means |
| --- | --- |
| `task:<id>-done` | issue or task `<id>` is finished |
| `build:green` / `build:red` | CI finished, with the verdict in the body |
| `review:<pr>-done` | a review posted for that PR |
| `file:<path>:ready` | a file another lane needs now exists |
| `schema:migrated` | a shared thing changed underneath everyone |

`*` matches any run of characters, so a lane can wait on `task:*-done` when it
does not know which of several tasks will land first. Body text is free: put the
fact the other lane needs in it, because the other lane has none of your context.

## Fan-out and free text

- Several lanes can wait on the same topic; one `board_post` wakes all of them.
  Useful for "nobody starts the integration run until all five features are in".
- A lane with no structured dependency gets told to talk: "`board_lanes` to see
  who is up; `board_send` lane-auth if you need the token format from them".
- `wake: false` queues a message for the recipient's next turn instead of
  starting one. Use it for "whenever you next run" notes, not for blockers.

## Unblocking a lane by hand

The board does not start sessions and a parked lane costs nothing, so a deadlock
is yours to break, from any shell:

```
node extensions/pi-board/cli.ts lanes
node extensions/pi-board/cli.ts post task:42-done "merged by hand, go ahead"
node extensions/pi-board/cli.ts send lane-auth "use the new token format"
node extensions/pi-board/cli.ts inbox lane-b
```

`/board` in any lane shows the same picture.

## When a lane ignores its wake

The agent's own rules say to act on a message only when it bears on its task, so
a vague brief produces a lane that reads the message and goes back to sleep. Two
habits prevent it:

- Name the topic in the brief, not in a later message. A lane that was never told
  what it is blocked on cannot connect a wake to its work.
- Say what to do *after* the wake ("carry on with the refresh"), not just that it
  will be woken. The wake arrives as its own turn with no other context.

If a wake does arrive and nothing starts, the extension notifies you and nudges
the session once; that is the watchdog, not normal behaviour worth briefing.
