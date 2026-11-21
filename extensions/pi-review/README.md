# pi-review

Agentic pull-request review for pi, run by pi itself inside GitHub Actions.

This extension is the **installer + runner** for that workflow. It does for pi
what Claude Code's `/install-github-app` does: provision a credential and an
identity, commit a caller workflow to the target repository, and let you pick
the model from a panel. Nothing runs in this repository: the job lives once in
`.github/workflows/pi-review-reusable.yml` here, and each reviewed repository
commits a small caller that runs it from `@main`.

> Not to be confused with [`earendil-works/pi-review`](https://github.com/earendil-works/pi-review),
> which is an interactive local `/review` command with no CI. This one installs
> a CI reviewer.

## Status

**Milestones 1–6 done, plus failure hardening (#27, #43–#47).** The runner, App
identity, workflow generation, provider credentials, settings panel, incremental
re-reviews, and sticky summary comment are implemented. `/pi-review settings`
walks the common fields in a menu (with "Edit raw JSON" for the rest), validates
the result, regenerates the caller, and commits it to a branch; `/pi-review
uninstall` commits the removal to a branch and offers to delete the credentials.

Implemented and tested:

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
- A run that does not submit is classified (`provider`, `incomplete`, `aborted`,
  `budget`, `post`), nudged once, recovered as a `COMMENT` review when the final
  answer is substantive, and reported through one edited failure comment. Every
  run uploads its transcript and resolved model/tool/retry state.

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

## Previous review threads

On follow-ups, the reviewer is shown the threads it already opened so it does
not repeat a finding that is already on the pull request, and so it can say
whether an earlier one still holds. Opt in per repository:

```json
{ "review": { "resolveStaleThreads": true } }
```

When enabled, the runner fetches the PR's unresolved review threads that were
started by a bot and lists them (id, path:line, body) in the review context.
Threads that are already resolved or written by people are never offered, and
the text is treated as untrusted data like the rest of the PR.

### Why the reviewer does not resolve them in CI

GitHub's `resolveReviewThread` mutation forbids a token that has *Pull requests:
write* but only *Contents: read* (`Resource not accessible by integration`). The
permission it wants is **Contents: write**, which also lets its holder push code
— GitHub's pull-requests team called that alignment intentional
([gh-aw#35726](https://github.com/github/gh-aw/issues/35726),
[community#204269](https://github.com/orgs/community/discussions/204269)).
pi-review asks for `contents: read` on purpose: the reviewer reads untrusted PR
text and has a shell, so a contents-write token would turn a prompt injection
into a push.

So the App cannot close its own threads, and the extension says so instead of
attempting nine refusals:

- The thread query asks for `viewerCanResolve`, GitHub's own answer for the
token that is running. No thread is offered for resolution when it is false.
- The reviewer is told to check each listing against the diff but not to call
  `resolve_review_threads`, and not to claim a thread was resolved.
- The job log carries one line naming the reason, and the tool (if called
  anyway) refuses without a request.
- `/pi-review install` reports it in its summary.

A local `/pi-review run --post` uses your own `gh` token, so resolution works
there whenever your account may resolve threads. Resolving is still a mutation,
so it only happens on a real run: `PI_REVIEW_DRY_RUN=1` never registers the
tool, even when the setting is on. When the token may resolve threads, the tool
accepts only ids from the fetched set, so it cannot resolve a human's thread or
invent one.

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

## When a run fails

A review can end without `submit_review`. The job classifies the ending instead
of treating every one as "the job failed or timed out":

| kind | what happened | what the job does |
| --- | --- | --- |
| `submitted` | the model called `submit_review` | posts the review |
| `incomplete` | the model ended in prose | one explicit nudge; if it still does not submit, a final answer of at least 400 characters is posted as a `COMMENT` review marked "submitted by recovery" |
| `provider` | a 429/5xx/overload/network error survived the retry budget | no review is posted; the failure comment names the provider and includes its error |
| `aborted` / `budget` | the step timed out or was cancelled, or the model hit its output limit | no review is posted; the comment says which |
| `post` | the review validated but GitHub rejected the post | the workflow retries the review, then its summary, before giving up |

Retries are pi's own policy, written into a throwaway agent directory from the
settings file:

```json
{
  "review": {
    "retry": {
      "maxRetries": 6,
      "baseDelayMs": 5000,
      "maxDelayMs": 60000,
      "providerMaxRetries": 2
    },
    "onProviderFailure": "fail"
  }
}
```

`providerMaxRetries` retries a single request and honours `Retry-After`;
`maxRetries` retries the failed assistant turn with exponential backoff. Six
agent retries at a five-second base is roughly three minutes of patience, which
covers the overload spikes that used to turn into a red check after sixteen
seconds. `onProviderFailure` is `fail` by default: a green check that posted no
review can let an unreviewed PR merge. Set it to `warn` for a provider that is
flaky and a check that is not required.

A failed run edits **one** comment per pull request instead of adding another.
The comment carries `<!-- pi-review:failed -->`, names the reason and the run
that produced it, and is written by `github-actions` so the workflow token can
always edit it. Reviews still post as the App.

Every run uploads `events.jsonl`, `review.json`, `recovery.json`,
`conclusion.json`, and `run-meta.json` as a `pi-review-pr-<n>-<run>` artifact
for seven days. `run-meta.json` records the resolved provider, model, thinking
level, tools, retry policy, last stream event, last stop reason, and pi's exit
code, so "it finished without submitting" can be diagnosed from the artifact
rather than a grep through the job log.

## Verifying with tests

Reviews are much better when the agent can run the suite. Two settings cooperate:

```json
{ "tools": { "bash": true }, "verify": { "installDependencies": true } }
```

With both on, the caller passes `install-dependencies: true` and the reusable
workflow's `Install pi and dependencies` step (8-minute limit) installs **every
ecosystem it finds**, so a polyglot repo works:
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

## Watching for the review

With [`pi-pr-subscribe`](../pi-pr-subscribe/) installed, ask pi to
`subscribe_pr_activity` after opening the PR and end the turn. The next review
arrives as its own turn, tagged `source="pi-review"`, alongside a `checks.settled`
verdict — no `gh pr checks` polling, no sleeping. A review posted by the App is
labelled `bot="true"` from the `[bot]` login; the review marker sets the source
tag even when it was posted through another identity.

When the agent has a reply to make, posting it with
`gh pr comment` or `gh api …/comments` is enough: the subscription records the
returned id, so the agent is not woken by its own comment.

## One App, many repositories

Create the App once; the wizard then remembers it on this machine:

- when it creates an App it saves the key to
  `~/.pi/agent/pi-review/<owner>.pem` (`0600`) and records the App ID, client ID,
  slug, and key path in `~/.pi/agent/pi-review.json` (`0600`);
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

The `PI_REVIEW_APP_ID` secret holds the App's **client ID** (the `Iv23…` value)
on a new install. An older install's numeric App ID still works as the JWT
issuer, and re-running `/pi-review install` refreshes the secret to the client
ID. The workflow passes it as `client-id` and narrows the minted token to
`contents: read`, `pull-requests: write`, and `issues: write`.

Personal accounts have no shared secrets, so each repository still receives a
copy of the key as a repo secret; the local copy makes that automatic.
Organizations can put the same key in an **organization secret** instead.
Deleting the App disables every repository; deleting one repository's secrets
disables only that repository. To stop reusing the App on this machine, delete
`~/.pi/agent/pi-review.json` and `~/.pi/agent/pi-review/`.

## Changing settings

`/pi-review settings` opens a menu for the common knobs: model, thinking, tools
(read-only vs +bash), strictness, verdict, dependency install, stale-thread
resolution, the retry budget, the provider-failure policy, and the `@pi` mention
trigger. Each entry shows the current value; **Save and continue** commits the
result, and **Edit raw JSON…** opens the committed file for provider, path
filters, triggers, and timeouts.

On save the JSON is validated (unknown enums are refused, numbers are clamped),
the workflow is regenerated from it, and both files are committed to
`pi-review/settings` (or the next free suffix) with a PR-compare URL. The
default branch is untouched.

`/pi-review status` shows the effective settings, whether the workflow file is
present, and whether `PI_REVIEW_API_KEY` is set.

## Updating pi-review

CI does not run this repository's working tree. The committed workflow is a
small caller that points at
`AutumnsGrove/pi-extensions/.github/workflows/pi-review-reusable.yml@main`, where
the job lives once. A change to that file reaches every project that installed
pi-review on its next run, with no commit in the project (issue #34).

The pi CLI version stays in the project: `.github/pi-review.json` → `pi.version`.

What still needs a local change is the caller, and only when a setting that
GitHub has to know before the job starts changes: the triggers, the path filter,
the mention trigger, or the timeout. Regenerate it with:

```sh
pnpm pi-review:sync           # rewrite .github/workflows/pi-review.yml
pnpm pi-review:sync --check   # exit 1 if the caller is out of date
```

`/pi-review settings` regenerates it when it saves. Nothing here re-pins a
commit, and there is no package ref in the settings any more; an older file's
`packageRef` is ignored.

## Uninstall

`/pi-review uninstall` commits the removal of the settings and workflow to
`pi-review/remove` and opens the compare page. It then offers to delete
`PI_REVIEW_API_KEY`, `PI_REVIEW_APP_ID`, `PI_REVIEW_APP_PRIVATE_KEY`, and the
`PI_REVIEW_APP_SLUG` variable. The GitHub App is **not** deleted over the API;
the summary links the pages to uninstall it and delete it.

## The generated workflow

`/pi-review install` writes `.github/workflows/pi-review.yml`, a caller of about
thirty lines:

- the `pull_request` trigger with the configured types and path filter, plus
  `issue_comment` when the `@pi` mention is on;
- the concurrency group, which is the pull request number *only for runs that
  will review*. The group expression repeats the job `if:` and falls back to
  `github.run_id` otherwise, because GitHub evaluates `concurrency` when the run
  is created — before the job `if:` is considered — so an ignored comment (or a
  draft push) sharing the group would cancel the review already in flight;
- `permissions` (contents read, pull requests and issues write);
- the job condition, and `uses: .../pi-review-reusable.yml@main` with the
  settings path, the two timeouts, and whether to install dependencies.

Everything else lives in the reusable workflow, which checks out the PR with
full history, checks the same-repo guard first, restores the pi and package
caches, installs pi and the caller's dependencies at the same time with no
secret in reach, fetches this package at the commit that defined the job
(`job.workflow_sha`, falling back to `main`), reads `.github/pi-review.json`,
mints the App token when the secrets are present (otherwise `GITHUB_TOKEN`),
and runs one headless pi. The Review step records the result instead of deciding
it: a recovery step retries a validated review or recovers the final assistant
text, a conclude step decides between success, a recovered warning, the
provider-failure policy, and a real failure, and a report step edits the one
failure comment. The step summary and the uploaded transcript always exist, so a
failure is explainable from the run itself.

Three choices in that job are deliberate:

- **The runner is pinned** to `ubuntu-26.04`, not `ubuntu-latest`, so a GitHub
  label rotation cannot change the operating system under a pull request.
- **The cache is requested by the job itself.** `cache-mode: write` is declared
  in the reusable workflow, which a called workflow may do when its caller does
  not cap it, so caching needs no per-project caller change. Only same-repo PRs
  reach the job, so a fork cannot write the cache, and caches saved by a
  `pull_request` run are scoped to that PR's merge ref: the second and later
  reviews of a PR hit them, a brand-new PR does not.
- **`Install pi` and `Install dependencies` are one step.** Both are
  network-bound with no secret in reach, so pi is installed in the background
  while the dependencies install and the script waits for it before finishing.
  A failed dependency install stays a warning; a failed pi install fails the
  step.

Edit `.github/pi-review.json`, not either YAML.

## Running in CI

The runner activates when `PI_REVIEW=1`. It reads:

| Variable | Meaning |
| --- | --- |
| `PI_REVIEW` | `1` turns the extension into the review harness |
| `PR_NUMBER` | pull request to review (else the workflow should pass one) |
| `PI_REVIEW_DRY_RUN` | `1` validates and writes an artifact instead of posting |
| `PI_REVIEW_OUTPUT` | path for the JSON artifact (`review`, `markdown`, `url`, `errorKind`, `recovered`) |
| `PI_REVIEW_REQUEST_CHANGES` | `1` allows `REQUEST_CHANGES` (default `COMMENT`) |
| `PI_REVIEW_BASE_REF` | base ref override for the local git fallback |
| `GH_TOKEN` | used by `gh pr view`, `gh pr diff`, and `gh api` when posting |
| `PI_REVIEW_MAX_COMMENTS` | inline comments kept separate; the rest fold into the summary |
| `OPENCODE_API_KEY` / `OPENROUTER_API_KEY` / … | the provider key, from the `PI_REVIEW_API_KEY` secret |

The shared job runs, with the provider, model, thinking level and tools taken
from the repository's settings:

```bash
pi -p --mode json --no-session --offline -na -nc \
  -ne -e /path/to/pi-extensions/extensions/pi-review/index.ts \
  -ns -np --no-themes --no-mcp \
  --tools read,grep,find,ls,submit_review \
  --provider <provider> --model <model> --thinking <level> \
  "Review pull request #$PR_NUMBER."
```

The extension loads the PR, injects the review context, and the agent finishes
by calling `submit_review`. A run that finishes without it gets one explicit
continuation asking for `submit_review`; if that also ends in prose, the runner
writes an `incomplete` artifact with the failure kind and recovers a substantive
final answer as a `COMMENT` review. Provider errors, aborts, and output-limit
stops are never recovered into a review.

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
  sandbox tools. The transcript artifact keeps the whole model stream for seven
  days, so a command that prints its environment can put the provider key there;
  keep the key dedicated and revocable, and leave `bash` off when a review does
  not need it.
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
failure.ts  classify a run that ended without submit_review; recovery helpers
submit.ts   submit_review tool + gh api posting
prompt.ts   system instructions + fenced PR context
runner.ts   CI wiring (PI_REVIEW=1)
local.ts    headless child pi for /pi-review run
```

See [`PLAN.md`](./PLAN.md) for the full design and the tracking issue for
progress.
