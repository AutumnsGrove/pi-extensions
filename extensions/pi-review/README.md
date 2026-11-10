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

**Milestones 1–4 done; milestone 5 partially.** The runner, App identity,
workflow generation, and provider credentials are implemented. `/pi-review
settings` opens the committed settings in an editor, validates them, regenerates
the workflow, and commits the result to a branch; `/pi-review uninstall` commits
the removal to a branch and offers to delete the credentials. The dedicated
settings panel is the remaining milestone-5 piece.

Milestones 1 (runner), 2 (App identity), 3 (workflow + settings), and 4
(provider credentials) are implemented and tested:

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

Not yet: the dedicated settings panel (milestone 5's remaining piece) and
polish such as incremental re-reviews and sticky comments (milestone 6).

## Commands

```
/pi-review install
/pi-review settings        # edit .github/pi-review.json, regenerate the workflow
/pi-review uninstall
/pi-review run [--post] [--pr N] [--base ref] [--model provider/id] [--thinking level] [--bash]
/pi-review status
/pi-review help
```

## App avatar

A new GitHub App gets an automatically generated identicon by default, and the
installer cannot set a different one: GitHub only accepts a logo upload from the
App settings UI.

To use the pi icon, open the App's settings (**Edit** → **Display information**)
and upload [`logo.png`](./logo.png), then **Set new avatar**. The image is the
official pi icon (512×512 PNG, from `earendil-works/pi`, MIT © 2025 Mario
Zechner — see [`logo.LICENSE`](./logo.LICENSE)); GitHub recommends 200×200 and
accepts PNG, JPG, or GIF under 1 MB. The icon has an opaque `#151413`
background, so setting the badge background to the same value makes the disc
blend with the glyph.

GitHub caches avatars, so comments posted before the change can keep the old
one.

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
   `gh secret set` on stdin (never printed or logged), then
   the App ID, then a `PI_REVIEW_APP_SLUG` repository variable. Finally the
   install page opens so you can select the repository, and the wizard verifies
   it with a short-lived App JWT (`GET /repos/{owner}/{repo}/installation`),
   polling briefly while GitHub catches up.
5. **Review credential** — a dedicated key for the provider in
   `.github/pi-review.json`, stored as `PI_REVIEW_API_KEY`:
   - **OpenCode Go** — device sign-in to the Console (the same grant
     `/login opencode-go` uses), then a new Go key named
     `pi-review-<owner>-<repo>`. The interactive `pi-<host>` key is never
     touched, and re-provisioning revokes only keys with that CI name. A
     dialog shows the wait: Escape cancels it, and a rejected, expired, or
     cancelled code offers a fresh code, a pasted key, or a skip.
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

- The App name is `pi-review-<owner>`: **one App per owner**, installed on as
  many repositories as you like. GitHub lets you edit the name on the creation
  page if it collides.
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

## Asking for a review

Comment `@pi` on any pull request to run a review on demand. The comment body is
the maintainer's request, so `@pi focus on the migration` narrows the review
instead of restating the whole diff. It is still treated as untrusted text and
fenced.

The mention path only runs when:

- the comment is on a pull request (not a plain issue);
- the author is an owner, member, or collaborator (not a random commenter);
- the author is not a bot;
- the check-out is a same-repo PR; a fork's merge ref is refused before the job
  can execute its code with secrets.

The workflow listens to `issue_comment` for this (default on); set
`triggers.mention: false` to disable it. Auto-reviews on push are unchanged.

## Resolving stale threads

On follow-ups, the reviewer can close the threads it already opened once it
verifies the new changes fixed them. Opt in per repository:

```json
{ "review": { "resolveStaleThreads": true } }
```

When enabled, the runner fetches the PR's unresolved review threads that were
started by a bot and lists them (id, path:line, body) in the review context. If
the diff verifies one is fixed, the agent calls `resolve_review_threads` with
the id and a one-line reason. The tool only accepts ids from that fetched set,
so it cannot resolve a human's thread or invent one, and the prompt tells it to
leave anything it cannot verify open. Threads that are already resolved or
written by people are never offered.

Resolving is a mutation, so it only happens on a real run: `/pi-review run`
needs `--post`, and the runner refuses to register the tool when
`PI_REVIEW_DRY_RUN=1`, even if the setting is on.

## Review strictness

The default is **significant issues only**: the reviewer reports things that
should block the change (correctness, security, data loss, races, tests that
hide a real bug) and skips naming, formatting, wording, optional refactors, and
"nits". If there is nothing significant, it says so without inline comments.

Set it per repository in `.github/pi-review.json`:

```json
{ "review": { "strictness": "significant" } }
```

- `significant` (default) — only merge-blocking findings.
- `balanced` — real defects and meaningful design/test gaps; still no pure style.
- `thorough` — adds minor suggestions, marked non-blocking.

For free-form repo rules ("we care about X", "never comment on Y"), put them in
`REVIEW.md` on the base branch; it is loaded into every review and cannot be
rewritten by a PR.

## Verifying with tests

Reviews are much better when the agent can run the suite. Two settings cooperate:

```json
{ "tools": { "bash": true }, "verify": { "installDependencies": true } }
```

With both on, the generated workflow adds:

- `actions/cache` for the npm/pnpm, pip/uv, Go, Cargo, Bundler, NuGet, and
  Composer stores, keyed by every supported lockfile;
- an `Install dependencies` step (8-minute limit, `continue-on-error: true`)
  that installs **every ecosystem it finds**, so a polyglot repo works:
  - Node: `pnpm-lock.yaml` (corepack pnpm), `package-lock.json` (`npm ci`),
    `yarn.lock` (classic `--frozen-lockfile` or Berry `--immutable`), Bun;
  - Python: `uv.lock` (uv), `poetry.lock`, `Pipfile.lock`, `requirements.txt`,
    or `pyproject.toml`;
  - Go (`go mod download`), Rust (`cargo fetch`), Ruby (`bundle install`),
    PHP (`composer install`), .NET (`dotnet restore`);
  - anything else: `verify.installCommand` replaces detection entirely;
- `PI_REVIEW_DEPS=installed|unavailable|none` in the job environment, which the
  runner turns into a prompt note: run the tests, do not claim you ran them, or
  no guidance.

```json
{ "verify": { "installDependencies": true, "installCommand": "make deps && make fixtures" } }
```

Installation failures never fail the review: the agent is told the dependencies
are unavailable and reviews by reading instead. The installer asks whether to
install dependencies whenever you allow `bash`, and `verify` is forced off when
`bash` is off. Running install scripts from the checkout is code execution from
the PR, which is why `bash` stays an explicit opt-in and only same-repo PRs run.

## Follow-up reviews

Every posted review carries a hidden marker. On the next push, the runner looks
up the last pi-review on the PR, and when its commit is an ancestor of the new
head it diffs only `last-reviewed...head`. The prompt then gets that review's
summary and asks for a follow-up: avoid repeating findings, check whether they
were addressed, and focus on the new changes. A force-pushed branch falls back
to a full review.

That incremental diff is a tree comparison, not a subset of the PR diff (a base
merge or a revert can put unrelated content in it), so the prompt sees the
increment while **inline positions validate against the full PR diff**. A
comment on something outside the PR is folded into the summary instead of
failing the review.

A second hidden marker identifies one **sticky summary comment** that is created
on the first run and updated in place afterwards:

> **pi-review** reviewed `abcdef123456` — commented · 3 inline comments · [details](…)

That keeps a stable status line on the PR instead of one status comment per
push. The review itself still carries the findings.

## One App, many repositories

Create the App once; the wizard then remembers it on this machine:

- when it creates an App it saves the key to
  `~/.pi/agent/pi-review/<owner>.pem` (`0600`) and records the App id, slug, and
  key path in `~/.pi/agent/pi-review.json` (`0600`);
- in another repository under the same owner, `/pi-review install` finds that
  entry, verifies the id/key with a short-lived App JWT, writes the secrets
  automatically, and **asks no App questions**. If the App is already installed
  on the repository (install it with **All repositories**), it does not even
  open the browser.
- if the key file moved or was deleted, it warns and falls back to the normal
  choices, including **Use an existing Pi GitHub App**. That asks for the App ID,
  then shows the `.pem` files it can find (Downloads, Desktop, home) so you pick
  one instead of typing a path; **Paste the key…** accepts the file contents in
  the editor, and a manual path is still available (drag the file into the
  terminal to paste it).

If you never downloaded a key: open the App settings → **Private keys** →
**Generate a private key**; the browser saves a `.pem` in Downloads, which the
picker will list.

Personal accounts have no shared secrets, so each repository still receives a
copy of the key as a repo secret; the local copy makes that automatic.
Organizations can put the same key in an **organization secret** instead.
Deleting the App disables every repository; deleting one repository's secrets
disables only that repository. To stop reusing the App on this machine, delete
`~/.pi/agent/pi-review.json` and `~/.pi/agent/pi-review/`.

## Changing settings

`/pi-review settings` opens a menu for the common knobs: model, thinking, tools
(read-only vs +bash), strictness, verdict, dependency install, stale-thread
resolution, and the `@pi` mention trigger. Each entry shows the current value;
**Save and continue** commits the result, and **Edit raw JSON…** opens the
committed file for provider, path filters, triggers, and pins.

On save the JSON is validated (unknown enums are refused, numbers are clamped),
the workflow is regenerated from it, and both files are committed to
`pi-review/settings` (or the next free suffix) with a PR-compare URL. The
default branch is untouched.

`/pi-review status` shows the effective settings, whether the workflow file is
present, and whether `PI_REVIEW_API_KEY` is set.

## Updating the pinned version

CI does not run whatever is on `main`: the workflow fetches this package at the
exact commit in `.github/pi-review.json` → `pi.packageRef`, and installs the pi
version in `pi.version`. Changes to the extension therefore do **not** reach PR
reviews until you re-pin.

```sh
git push                      # the ref must exist on GitHub first
pnpm pi-review:pin            # pin to the current HEAD (or: pnpm pi-review:pin <sha|tag>)
pnpm pi-review:pin --check    # verify the workflow matches the settings (exit 1 if stale)
git commit -am "Re-pin pi-review"
```

`pin` rewrites only `pi.packageRef` and regenerates `.github/workflows/pi-review.yml`
from the settings. To change anything else, edit `.github/pi-review.json` (or
`/pi-review settings`) and run `pnpm pi-review:pin <current ref>` to regenerate.
To change the pi version, edit `pi.version` the same way.

Use a **merge commit** (not squash/rebase) when merging a branch you pinned to,
or the pinned SHA becomes unreachable and the workflow cannot fetch it. A tag is
the most durable ref.

## Uninstall

`/pi-review uninstall` commits the removal of the settings and workflow to
`pi-review/remove` and opens the compare page. It then offers to delete
`PI_REVIEW_API_KEY`, `PI_REVIEW_APP_ID`, `PI_REVIEW_APP_PRIVATE_KEY`, and the
`PI_REVIEW_APP_SLUG` variable. The GitHub App is **not** deleted over the API;
the summary links the pages to uninstall it and delete it.

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
  the failure step can run. The concurrency group is the pull request number
  *only for runs that will review*: the group expression repeats the job `if:`
  and falls back to `github.run_id` otherwise, because GitHub evaluates
  `concurrency` when the run is created — before the job `if:` is considered —
  so an ignored `issue_comment` (or a draft push) sharing the group would
  cancel the review already in flight;
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
