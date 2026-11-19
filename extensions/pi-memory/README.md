# pi-memory

Automatic, file-based project memory for pi. It remembers the quiet things a
repository cannot: *use pnpm, not npm*, *that test is flaky on CI*, *the auth
rewrite was compliance-driven*, *yes, one PR was right*.

```
memory/--Users-autumn-Documents-Projects-pi-extensions--/
├── MEMORY.md                     # index only: one line per memory
├── feedback_pnpm.md
├── project_auth_rewrite.md
└── user_autumn.md
```

The store is plain Markdown under `~/.pi/agent/memory/`. Never in the
repository, never committed, never hidden in a database.

## Why there are two tiers

A single `MEMORY.md` that holds every fact is the obvious wrong answer: it is
unbounded, always in context, and becomes an activity log within a month.

So the index is **links and hooks only**, and it is the only part always in
context. Bodies are read on demand — by capped recall, `memory_read`, or
`memory_search`.

| Budget | Default |
| --- | --- |
| Index lines | 200 |
| Index bytes | 25 KB |
| Recalled bodies per user run | 5 |
| Recalled body bytes per run | 4 KB |
| Body cap per memory | 4 KB |
| Background extraction | one model call every 3 settled runs |

When the index overflows, the tail is dropped and one line says how many
memories are hidden; `/memory dream` is the way back.

## Four types, and a long exclusion list

| Type | Belongs there |
| --- | --- |
| `user` | Role, expertise, preferences, how to pitch explanations |
| `feedback` | Corrections **and** confirmations, with why and when |
| `project` | Goals, constraints, the *why* behind a decision, incidents |
| `reference` | Pointers to external systems (a board, dashboard, queue) |

Never saved: code structure, paths, conventions, or architecture; git history
or authorship; debugging recipes whose fix is in a commit; anything already in
`AGENTS.md`; ephemeral task state; secrets. The exclusions apply even when asked
to "save this" — if asked for an activity log, the agent is told to ask what was
*surprising* instead.

A memory file:

```markdown
---
name: Use pnpm, not npm
description: Autumn's package manager preference for this repository
type: feedback
created: 2026-11-19T05:01:10Z
---

Use pnpm for installs, scripts, and new workspace members.

**Why:** npm rewrites the lockfile and breaks the pinned workspace layout.
**How to apply:** Run `pnpm …`; if a doc says `npm`, fix the doc.
```

## Capture

Two paths, one skip rule.

1. **Inline, free.** A `pi-memory` section in the system prompt explains the
   store, the four types, the exclusions, and the format. Four tools are
   available; the model saves immediately when corrected, when a non-obvious
   choice is confirmed, or when asked. This is where most `feedback` and `user`
   memories come from, because the model already holds the *why*.

2. **Background, throttled.** On `agent_settled`, if at least three new
   model-visible messages exist since the cursor and the main agent did **not**
   save this run, one model call reads that slice plus the existing manifest and
   returns JSON. The extension validates the writes (types, lengths, secrets,
   near-duplicates, a five-write cap), applies them, and advances the cursor
   only on success. No fork, no tools, no filesystem access for the extractor.

The skip rule is load-bearing: without it the same correction is saved twice,
once by each path.

Every accepted write shows one line — `Saved 2 memories · /memory` — expandable
with `Ctrl+O`.

## Recall

On each user-started run, memories are scored deterministically by keyword
overlap over name (×4), description (×2), type, and body, with a small recency
nudge. A memory needs a strong match: its name or description, or at least two
body terms. The top five that fit a 4 KB budget are injected as one hidden
message.

- Files already surfaced or read this session are never surfaced again.
- The injected block is labelled as **data, not instructions**, and says to
  verify a named file, flag, or command before relying on it.
- "Ignore memory" means do not cite or mention it.
- Child sessions and fork descendants (a session with a parent) get no recall:
  they already carry the parent's context.

`memory_search` is the explicit path: keyword by default, semantic when the
local Ollama model from [`semantic-search`](../semantic-search/) is available.
Semantic vectors are cached in `~/.pi/agent/memory-vectors/`, never in the
store, so a shared Claude Code folder stays exactly Claude's files.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Save or update a memory. Same title updates in place; `replace` targets a file. |
| `memory_read` | Read one body by filename or title. |
| `memory_search` | `keyword`, `semantic`, or `auto`. |
| `memory_forget` | Delete a wrong or obsolete memory (exact name or filename only). |

## Commands

```
/memory                 status of this project's store
/memory status          same
/memory list            every memory, one line each
/memory root            the repository-root store (for monorepos)
/memory dream           merge, prune, and rewrite the store
/memory import          copy from Claude Code's store (--dry-run previews)
/memory eval            replay saved sessions; --extract dry-runs extraction
/memory promote <name>  draft an AGENTS.md entry; never writes it
/memory off | on        pause or resume memory for this session
```

`/memory dream` is the consolidation pass: merge near-duplicates, resolve
contradictions in favour of the newer memory, convert relative dates, delete
what is obsolete, and rewrite the index under the caps. It shows the write and
delete counts and the model cost. Writes apply first; if any write is rejected
or fails, deletions are skipped for that pass, so a bad merge cannot empty the
store.

Auto-dream is opt-in (`dream.auto`) and runs at session start when at least 24
hours and 5 sessions have passed since the **last** consolidation. A store that
has never been consolidated stays quiet until you run `/memory dream` once:
there is no meaningful "last one" to measure from, and an unsolicited model call
on first use is a bad surprise.

## Configuration

`~/.pi/agent/memory.json`, all optional:

```json
{
  "enabled": true,
  "scope": "cwd",
  "store": "pi",
  "model": "anthropic/claude-haiku-4-5",
  "inlineSave": true,
  "semantic": true,
  "extraction": { "enabled": true, "every": 3, "minMessages": 3, "maxWrites": 5 },
  "recall": { "enabled": true, "maxFiles": 5, "maxBytes": 4096 },
  "dream": { "auto": false, "afterHours": 24, "afterSessions": 5 },
  "index": { "maxLines": 200, "maxBytes": 25600 }
}
```

- `scope: "cwd"` matches pi's session grouping. `"git-root"` shares one store
  across a monorepo. `/memory root` always inspects the repository-root store.
- `store: "claude"` points at Claude Code's own memory folder for the project,
  for one shared brain. The layout is undocumented and may change, so treat it
  as opt-in. The slug difference (`--Users-…--` vs `-Users-…-`) is bridged.
- `model` overrides the extraction/consolidation model. Default: the session's
  active model. Extraction and dream cost is visible in `/memory status`.
- `enabled: false` turns off the prompt section, recall, extraction, and makes
  the tools inactive. `/memory` still reports status.

Environment overrides: `PI_MEMORY_DIR` (the store itself), `PI_MEMORY_CONFIG`,
`PI_MEMORY_DISABLED=1`, `PI_MEMORY_SCOPE`, `PI_MEMORY_STORE`,
`PI_MEMORY_MODEL`, `PI_MEMORY_AUTO_DREAM`, `PI_MEMORY_EXTRACT_EVERY`.

## Claude Code import

```
/memory import --dry-run   # what would come across
/memory import             # copy, dedupe, rewrite the index
```

One-way. Reads `~/.claude/projects/<slug>/memory/`, skips `MEMORY.md`, fills in
missing frontmatter from filenames and bodies, dedupes by name, description, and
body similarity, and never edits or deletes Claude's files.

## Eval

```
/memory eval             recall overhead over the last 20 sessions
/memory eval --extract   also run extraction on 3 sessions, writing nothing
```

The report goes to `~/.pi/agent/memory-eval/<hash>.md` and gives the numbers
that matter: how often recall fires, approximate tokens injected (median, p95,
max), which memories keep coming back, and — with `--extract` — what the
extractor proposed, what validation rejected, and with what reasons. The last
step is deliberately still human: the validator cannot tell whether an accepted
memory restates the tree, `AGENTS.md`, or a commit. The report lists every
proposed write for a spot-check.

## Privacy

- Local files only, mode `0600`, outside the repository.
- Background extraction sends the recent conversation slice to the provider the
  session is already using. Nothing else leaves the machine.
- A secret scan refuses writes that look like a PEM key, AWS/GitHub/Slack/
  OpenAI/Anthropic/Stripe/Google token, JWT, bearer token, credentialed
  connection string, or a real-looking credential assignment. Refusals name the
  shape, never the value.
- Recalled memory is wrapped and labelled as data; a memory file could contain
  prompt injection, so it is never treated as an instruction.
- Memory never promotes itself into `AGENTS.md` or a skill.

## Not in v1

Team or shared memory, sync, a second vector database, Obsidian, cross-project
global memory, subagent memory, and automatic edits to `AGENTS.md` or skills.

## Development

Pure modules with tests beside the extension:

```bash
pnpm vitest run extensions/pi-memory
pnpm check
```

`extension.ts` is the wiring and takes a minimal fake `ExtensionAPI` in tests;
the store, recall, search, extraction, secret scan, and import modules have no
pi dependency and are tested directly.
