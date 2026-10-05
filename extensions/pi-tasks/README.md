# pi-tasks

A small task-list primitive for pi. The model gets one `todo` tool, and the
list renders as a live panel just above the editor, so the plan stays on screen
while work moves.

```
● Tasks (2/6)
├─ ✓ Create the domain entity
├─ ✓ Create the repository interface
├─ ◐ Create the repository (writing the SQL)
├─ ○ Register DI bindings
└─ ○ Add integration tests
+1 more · /todos
```

## Why not `rpiv-todo`?

[`@juicesharp/rpiv-todo`](https://pi.dev/packages/@juicesharp/rpiv-todo) is a
great extension, but it is ~2,800 lines: a dependency graph with cycle
detection, tombstones, owner/metadata, a config file, nine locales, lazy
loading, per-session overlays, collapse keys, and turn-based fading. `pi-tasks`
is the primitive without the rest — roughly 300 lines and a single test file.

## Tool

`todo` with four actions:

| Action | Params | Effect |
| --- | --- | --- |
| `create` | `subject`, optional `activeForm` | Adds a `pending` task with the next id. |
| `update` | `id`, plus `subject` / `status` / `activeForm` | Refines a task, moves its status, or sets the in-progress label. |
| `delete` | `id` | Removes the task. Ids keep counting up, so old ids never get reused. |
| `list` | — | Returns every task as a text list. |

Statuses are `pending`, `in_progress`, and `completed`. Transitions are
unrestricted — the model owns the plan, and a strict state machine only adds
error surface at this size.

The tool also ships `promptSnippet` / `promptGuidelines` so the model knows to
mark work in progress before starting, complete it immediately, keep one task
in progress, and never call something done while tests fail.

## Panel

- Starts blank: nothing is rendered until the first task exists.
- Renders above the editor while any unfinished task exists.
- Shows up to **five** unfinished tasks. Completed tasks are omitted; the
  heading still counts them (`Tasks (done/total)`).
- If the list overflows, the `in_progress` task is pinned into view regardless
  of position, and a `+N more · /todos` line appears.
- `/todos` prints **every** task, grouped `Pending` / `In Progress` /
  `Completed`.

## Keeping the model honest

Prompt guidelines alone don't make every model maintain the list, so the
extension nudges. Every nudge is hidden from the TUI (`display: false`) and
only fires for a plan the model engaged with **in the current run**, so
leftover tasks from an earlier session never nag.

- **Drift nudge** — after **two consecutive turns** that ran tools but never
  touched the list, a one-line reminder is injected into the next request. A
  `todo` call resets the streak, so a task that is actively being worked on is
  never nagged. Repeated reminders are deduped by list state and re-sent at most
  every few turns.
- **Settle reconciliation** — when a run is about to end with unfinished tasks,
  the model gets exactly one forced request to reconcile the list: mark
  finished work completed, start the next task, or tell the user what remains.
  It fires at most once per run, so there is no loop.

## Persistence

State lives entirely in each tool result's `details` (the full snapshot after
every call), so it is rebuilt from the active branch on `session_start`,
`session_compact`, and `session_tree`. The extension writes no files of its
own; pi persists the snapshots in the session JSONL. It survives `/reload`,
resume, compaction, and branch switches, and each branch shows the list as of
that point in history.

Compaction *does* strip the task list from the model's working memory (the
snapshot lives in `details`, which is never sent to the model). So on every
successful compaction the extension re-injects a hidden one-line reminder of
the unfinished tasks — ids, statuses, and the in-progress label — to keep the
plan alive across the boundary. It only fires when something is unfinished and
is not shown in the TUI (`display: false`), so you only see it via `/todos` and
the panel.

Tool state is keyed by session id. A detached child session keeps its own list
and never overwrites the foreground panel.

## Install

Part of the [`pi-extensions`](..) package:

```bash
pi install git:github.com/AutumnsGrove/pi-extensions
```

Or load this directory for one run:

```bash
pi -e /path/to/pi-extensions/extensions/pi-tasks
```
