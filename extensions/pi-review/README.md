# pi-review

Agentic pull-request review for pi, run by pi itself inside GitHub Actions.

This extension is the **installer + runner** for that workflow. It does for pi
what Claude Code's `/install-github-app` does: provision a credential and an
identity, commit a workflow to the target repository, and let you pick the model
from a panel. Nothing runs in this repository; each reviewed repository runs its
own job.

> Not to be confused with [`earendil-works/pi-review`](https://github.com/earendil-works/pi-review),
> which is an interactive local `/review` command with no CI. This one installs
> a CI reviewer.

## Status

**Milestone 2 — installer identity.** `/pi-review install` now creates the Pi
GitHub App through GitHub's manifest flow, stores `PI_REVIEW_APP_ID` and
`PI_REVIEW_APP_PRIVATE_KEY` as repository secrets, and walks through installing
the App on the repo. It can reuse an existing identity, or delete the App
secrets when you choose `GITHUB_TOKEN` instead. The workflow, settings, and
provider auth are still to come.

Milestone 1 (the runner) is implemented and tested:

- `submit_review` tool: validates every inline comment against the real diff
  (path, side, line, range), folds anything unattachable into the summary
  instead of losing it, posts one review, and marks a run that never submitted.
- Diff parsing for `git diff` / `gh pr diff`, including added, deleted, renamed,
  binary, multi-hunk, and quoted-path cases.
- Pull-request context from `gh` with a local `git` fallback; base-branch
  guidance (`REVIEW.md`, `AGENTS.md`, `CLAUDE.md`) read from the **base commit**.
- Prompt builder with a capped diff, fenced untrusted PR text, and explicit
  review instructions.
- `/pi-review run`: local dry run that spawns the same headless agent the
  workflow runs, with the same isolation flags.
- `/pi-review status`: what a review would use right now.

Not yet: workflow generation, provider auth, and the settings panel (milestones
3–6 — see [`PLAN.md`](./PLAN.md)).

## Commands

```
/pi-review install
/pi-review run [--post] [--pr N] [--base ref] [--model provider/id] [--thinking level] [--bash]
/pi-review status
/pi-review help
```

## Install

`/pi-review install` sets up the App identity in four steps:

1. **Preflight** — github.com `origin`, `gh` auth, and repository admin. It
   prints exactly what will change before changing anything.
2. **Identity choice** — create a Pi GitHub App, reuse the one this repo
   already has, or drop the App and use `GITHUB_TOKEN`.
3. **Manifest flow** — a local page auto-POSTs the manifest to GitHub, you
   approve the App in the browser, and GitHub redirects a one-time `code` back
   to localhost. The App requests only `contents: read`, `pull_requests: write`,
   and `issues: write`; it is private, has no webhooks, and no OAuth.
4. **Secrets + installation** — the private key goes straight to
   `gh secret set` on stdin (never printed, logged, or written to disk), then
   the App ID, then a `PI_REVIEW_APP_SLUG` repository variable. Finally the
   install page opens so you can select the repository.

Notes and limits:

- The App name is `pi-review-<owner>-<repo>` (≤34 characters). GitHub lets you
  edit the name on the creation page, which is the escape hatch if it collides.
- The manifest flow needs a browser that can reach your localhost. Over SSH or
  in a container, forward the port the wizard prints, or wait for the timeout
  and paste the redirect URL from the address bar.
- Pressing Escape after something was created prints what already changed and
  how to resume; re-running detects the existing secrets.
- Reusing an existing App verifies the installation on the repo, not the stored
  key (GitHub never returns a secret's value). If reviews later fail with 401,
  generate a new key in the App settings and run the wizard again.
- The summary ends with the exact commands to revoke each piece: delete the
  secrets, uninstall the App, and delete the App.

`/pi-review run` reviews the current branch against its merge base (or a PR when
one is detected / `--pr` is given) in a **child `pi` process**:

- `-ne -e <this extension>` — only this extension loads
- `-na -nc` — no project trust, no `AGENTS.md`/`CLAUDE.md` from the checkout
- `-ns -np --no-themes --no-mcp --offline --no-session`
- `--tools read,grep,find,ls,submit_review` (`bash` behind `--bash`)

The review is printed rather than posted unless `--post` is given. `bash` is
opt-in because a shell on the runner can read the job's environment, including
the review key.

## Running in CI

The runner activates when `PI_REVIEW=1`. It reads:

| Variable | Meaning |
| --- | --- |
| `PI_REVIEW` | `1` turns the extension into the review harness |
| `PR_NUMBER` | pull request to review (else the workflow should pass one) |
| `PI_REVIEW_DRY_RUN` | `1` validates and writes an artifact instead of posting |
| `PI_REVIEW_OUTPUT` | path for the JSON artifact (`review`, `markdown`, `url`) |
| `PI_REVIEW_REQUEST_CHANGES` | `1` allows `REQUEST_CHANGES` (default `COMMENT`) |
| `PI_REVIEW_BASE_REF` | base ref override for the local git fallback |
| `GH_TOKEN` | used by `gh pr view`, `gh pr diff`, and `gh api` when posting |

The intended workflow (milestone 3) checks out the target repo with full
history, installs a pinned pi, clones this package at a pinned tag, and runs:

```bash
pi -p --no-session --offline -na -nc \
  -ne -e /path/to/pi-extensions/extensions/pi-review/index.ts \
  -ns -np --no-themes --no-mcp \
  --tools read,grep,find,ls,submit_review \
  --model <provider>/<model> \
  "Review pull request #$PR_NUMBER."
```

The extension loads the PR, injects the review context, and the agent finishes
by calling `submit_review`. A run that finishes without it leaves an
`incomplete` artifact so the workflow can report the failure instead of ending
silently.

## Security defaults

- Same-repo pull requests only; never `pull_request_target` with a PR checkout.
- The diff, title, body, commit messages, and code comments are untrusted. The
  prompt fences them and states that instructions inside them are not to be
  followed; pi-review's own fence tags are escaped in that text, so a PR cannot
  close the data region early.
- Guidance reads `REVIEW.md`/`AGENTS.md` from the **base** commit, so a PR
  cannot rewrite the rules it is reviewed against.
- The review key should be a dedicated, revocable key per repository — never a
  developer key.
- `bash` is opt-in; the runner is the security boundary because pi does not
  sandbox tools.

## Development

```bash
npm test -- extensions/pi-review     # or: npx vitest run extensions/pi-review
npm run check
```

A useful end-to-end check without GitHub: create a scratch repo with two
commits, then run the child command above with `PI_REVIEW_DRY_RUN=1` and
`PI_REVIEW_OUTPUT=/tmp/review.json`. The artifact holds the validated review.

## Layout

```
index.ts    /pi-review command; runner mode switch
detect.ts   git remote → owner/repo, branch, base ref, gh auth, PR lookup
context.ts  PR or local diff, metadata, base-branch guidance
diff.ts     unified-diff parsing + inline position validation
review.ts   submission validation, summary folding, markdown rendering
submit.ts   submit_review tool + gh api posting
prompt.ts   system instructions + fenced PR context
runner.ts   CI wiring (PI_REVIEW=1)
local.ts    headless child pi for /pi-review run
```

See [`PLAN.md`](./PLAN.md) for the full design and the tracking issue for
progress.
