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

**Milestone 4 — provider credentials.** The installer now mints the review key
instead of only accepting a paste: OpenCode Go reuses the Console device grant
and provisions a dedicated per-repo key, OpenRouter runs the OAuth PKCE flow and
exchanges the code for a user-controlled key, and any other provider falls back
to a pasted key. Everything lands in `PI_REVIEW_API_KEY`.

Milestones 1 (runner), 2 (App identity), and 3 (workflow + settings) are
implemented and tested:

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

Not yet: the settings panel and `uninstall` (milestone 5), and polish
(milestone 6).

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
   install page opens so you can select the repository, and the wizard verifies
   it with a short-lived App JWT (`GET /repos/{owner}/{repo}/installation`),
   polling briefly while GitHub catches up.
5. **Review credential** — a dedicated key for the provider in
   `.github/pi-review.json`, stored as `PI_REVIEW_API_KEY`:
   - **OpenCode Go** — device sign-in to the Console (the same grant
     `/login opencode-go` uses), then a new Go key named
     `pi-review-<owner>-<repo>`. The interactive `pi-<host>` key is never
     touched, and re-provisioning revokes only keys with that CI name.
   - **OpenRouter** — OAuth PKCE: a local callback receives a one-time code,
     the verifier never leaves the process, and `key_label` is the repository
     name. The headless fallback pastes the code the page shows.
   - **Anything else** — paste a key, or set `providerEnv` in the settings file
     and add `PI_REVIEW_API_KEY` yourself.
6. **Settings** — thinking level, whether the reviewer may run tests (`bash`),
   and `COMMENT` vs `REQUEST_CHANGES`. The model and provider come from the
   session that runs the wizard and are written to `.github/pi-review.json`,
   which you can edit afterwards.
7. **Workflow** — the settings file and the generated workflow are committed to
   `pi-review/setup` (or the next free suffix) off the default branch, pushed,
   and the PR-compare page opens. The default branch is never written to, and
   your checkout is restored. `.github/pi-review.json` is the policy; the YAML is
   generated from it.

Notes and limits:

- The App name is `pi-review-<owner>-<repo>` when it fits in GitHub's 34
  characters, otherwise `pi-review-<repo>` (a readable short form rather than a
  truncated word). GitHub lets you edit the name on the creation page, which is
  the escape hatch if it collides.
- The manifest flow needs a browser that can reach your localhost. Over SSH or
  in a container, forward the port the wizard prints, or wait for the timeout
  and paste the redirect URL from the address bar.
- Pressing Escape after something was created prints what already changed and
  how to resume; re-running detects the existing secrets.
- Reusing an existing App asks you to confirm the installation: the stored key
  cannot be read back, and `/user/installations` needs a GitHub App *user* token
  (a `gh` token is rejected), so there is nothing to verify against. If reviews
  later fail with 401, generate a new key in the App settings and run the
  wizard again.
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

## The generated workflow

`/pi-review install` writes `.github/workflows/pi-review.yml`:

- triggers: `pull_request` `opened` / `synchronize` / `ready_for_review` /
  `reopened`, plus optional `paths` filters from `paths.include` / `paths.exclude`
  (rendered as one `paths` list with `!` negations, because GitHub rejects
  `paths` and `paths-ignore` together);
- skips drafts (unless configured), fork PRs (secrets are unavailable), and
  optionally bot authors;
- one job, `contents: read`, `pull-requests: write`, `issues: write`,
  `concurrency` cancel-in-progress, job timeout = review timeout + 5 minutes so
  the failure step can run;
- checks out the PR with full history, installs a pinned pi, fetches this
  package at `settings.pi.packageRef`, mints the App token when
  `identity: "app"`, then runs one headless pi with the review extension;
- fails the step if the run wrote no artifact or the artifact says
  `incomplete`, so the next step posts a "could not complete this review"
  comment instead of ending silently;
- always writes a step summary (verdict, inline comment count, review URL).

Edit `.github/pi-review.json`, not the YAML; re-running install regenerates it.

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
| `PI_REVIEW_MAX_COMMENTS` | inline comments kept separate; the rest fold into the summary |
| `PI_REVIEW_REQUEST_CHANGES` | `1` allows `REQUEST_CHANGES` |
| `OPENCODE_API_KEY` / `OPENROUTER_API_KEY` / … | the provider key, from the `PI_REVIEW_API_KEY` secret |

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
- The provider key is minted as a dedicated, revocable key per repository. It
  is written only to the repository secret, never to the settings file, a log,
  or the terminal (the paste path is the exception: the key is visible while
  typing, which the prompt says).
- OpenRouter PKCE: the code verifier stays in the process, so a leaked
  authorization code cannot be exchanged; the callback validates `state`.
  Revoke minted keys at <https://openrouter.ai/keys>.
- OpenCode Go: keys live under the `pi` service account in the Console; revoke
  them there. The CI key name makes them easy to spot.

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
