# pi-review — one-command agentic PR review for pi

Goal: run one command inside pi (`/pi-review install`) and have the current
repository reviewed by a **pi agent running in GitHub Actions** on every pull
request — the same experience as Claude Code's `/install-github-app`, but with
whatever provider pi is logged into (OpenCode Go, OpenRouter, …), with the
model configurable from a panel.

Status: **milestones 1–4 implemented, milestone 5 partly:** runner, App
identity, workflow + settings, provider credentials, plus a settings editor and
uninstall. The dedicated settings panel is the remaining milestone-5 piece. Researched 2026-11-05; scope
updated after owner review (name `pi-review`, no turn budget, OpenCode Go in CI is
explicitly permitted). Tracked in the GitHub issue "Add `pi-review` extension".

Implemented in milestone 1: `diff.ts`, `detect.ts`, `context.ts`, `review.ts`,
`submit.ts`, `prompt.ts`, `runner.ts`, `local.ts`, and the `/pi-review run`
`/pi-review status` commands, milestone 2 added the manifest flow, secret
storage, installation check, and `/pi-review install`, and milestone 3 added the
settings schema, the workflow generator, and the branch writer, and milestone 4
added OpenCode Go and OpenRouter credential minting, and milestone 5 added the
settings editor and uninstall, with 217 tests in the extension. See [`README.md`](./README.md) for the current usage and the
deviations recorded at the end of this file.

## Why agentic (and not "diff in, comments out")

The value of the Claude Code reviewer is that it is a harness, not a prompt: it
checks out the PR, reads surrounding files, runs the tests, writes throwaway
code to probe an error path, and only then comments. Pi is the same shape, so
the review job should run `pi` itself with `read/grep/find/ls/bash`, not call a
model with a pasted diff.

## What we learned

### How Claude Code does it (the thing to imitate)

- `/install-github-app` (docs: code.claude.com/docs/en/github-actions) is a
  guided wizard: (1) installs the **Claude GitHub App** on the repo,
  (2) obtains a credential — reuses the CLI's existing key, or mints a
  long-lived subscription token (`claude setup-token`), or takes a pasted key —
  and saves it as a **repo Actions secret** (`ANTHROPIC_API_KEY` /
  `CLAUDE_CODE_OAUTH_TOKEN`), (3) pushes a branch with workflow files
  (`claude.yml` for `@claude`, `claude-code-review.yml` for auto review) and
  opens the browser at a ready-to-create PR. Needs repo admin + `gh` auth. It
  can be paused after the App step ("Skip for now") and re-run to finish; a
  re-run offers "Update workflow file with latest version". Esc aborts between
  steps and prints what already happened.
- The workflow runs `anthropics/claude-code-action@v1`. Review mode is
  "automation mode": a `prompt` is given, triggers are
  `pull_request: [opened, synchronize, ready_for_review, reopened]`,
  permissions `contents/pull-requests/issues: read` + `id-token: write`.
  Model and **turn cap are CLI flags** passed via `claude_args`
  (`--model …`, `--max-turns N`; the old `max_turns`/`model` inputs are
  deprecated). Inline comments only post if the inline-comment MCP tool is in
  `--allowedTools`. Draft/closed/already-reviewed PRs are skipped. Fork PRs
  get no secrets, so review only runs for same-repo branches.
- The same action supports `use_sticky_comment`, `track_progress`, a
  `classify_inline_comments` filter, `settings` JSON, plugins, and
  Bedrock/Vertex/Foundry via OIDC. Auth to GitHub is the App's OIDC token
  exchange (no PAT).
- **The max-turns failure the user hit is real and widely reported.** Public
  PRs/issues describe reviews that hit the cap before submitting anything
  (raised 5→20 on large diffs; 15→25 because the job "ends before posting a
  verdict"; 50→80 plus prompt text to abort with a comment before the cap).
  `--max-turns` counts assistant turns, not tool calls. Also: when the cap is
  hit the action's output file is never written (claude-code-action #1226) and
  some harnesses misclassify `error_max_turns` as retryable. Decision: pi has no
  native turn cap, so we **do not build one** (see Run limits). Cost/runaway
  protection comes from native GitHub/pi controls instead.
- Claude's App asks for a broad shared permission set (Actions, Checks,
  Contents, Discussions, Issues, PRs, Workflows, …); a custom minimal App is
  the documented escape hatch.

### Other products with the same "one command / one click" shape

| Product | Install | Notes worth stealing |
| --- | --- | --- |
| OpenCode (`opencode github install`) | CLI walks App install → workflow → secrets | Workflow is just `opencode/github@latest` + `model: provider/model` + provider key env; `variant` for reasoning; triggers `/oc` `/opencode`; OIDC→App token, or `use_github_token` fallback. |
| Gemini CLI (`/setup-github`) | Slash command copies example workflows | `gemini-dispatch.yml` fan-out workflow; auto-review on PR open **and** `@gemini-cli /review` on demand; custom GitHub App recommended for GitHub auth. |
| Kilo Code Reviewer | SaaS GitHub App + dashboard toggle | Model picker in settings; skips drafts/bot PRs; **reads `REVIEW.md` from the base branch, not the PR branch** (so a PR can't rewrite its own review rules); API/UI sub-reviewers; max review time is configurable. |
| Greptile | SaaS GitHub App | Repo graph index, 👍/👎 learning, "Fix with your agent" button. Not agentic-in-CI; informs a possible later "memory" feature only. |

### Pi-specific prior art (nobody ships the installer; several ship the runner)

- **`earendil-works/pi-review`** — interactive `/review` + `/end-review`
  (uncommitted, branch, commit, `pr <n>` via `gh` checkout), loads
  `REVIEW_GUIDELINES.md`. Local only; no CI. Name collision to avoid.
- **`narumiruna/pi-action`** — composite actions `review` / `triage` /
  `rebase`; posts a summary comment + inline comments; runs with no tools or
  extensions (diff only); `pull_request` only.
- **`pi-harness-action`** (Marketplace) — runs pi with any provider or
  OpenAI/Anthropic/Google-compatible `base-url`; `api-key`, `auth.json`
  passthrough (with refreshed-token write-back secret), `models.json`,
  `thinking`, `exclude-tools`; token **or** GitHub App (`client-id` +
  `private-key`); pi is given read-only `github-mcp-server` and *submits* a
  structured result that the action posts (review states
  comment/request-changes/approve, inline comments with body fallbacks,
  incremental re-review since the last reviewed commit). Declines project
  trust so repo `.pi/` is ignored. No max-turns/timeout documented. Its own
  security note: a shell on the runner can read `auth.json`/env, so for
  untrusted PRs drop `bash,edit,write`.
- **Single-repo workflows** (e.g. `richpjames/on-the-beach#354`):
  `pi -p --no-session --provider zai --model … --tools read,grep,find,ls`
  with `--no-extensions --no-skills --no-prompt-templates --no-themes`, pinned
  pi version, diff embedded in the prompt (truncated at 150 KB), `gh pr
  review` to post. Reviewer-noted gaps: no sticky comment (one per push), fork
  PRs silently skipped, no budget.
- **`@sirfetch-d/pi-code-review`** — `/code-review` runs isolated pi
  subprocesses on a PR, `--comment` opt-in. **Sim**'s pi block — pins base/head
  SHAs, read/search tools only, validates inline coordinates against the local
  diff, submits one review. **`github/gh-aw` #69131** — headless pi support in
  GitHub Agentic Workflows (open at time of research).

**Gap:** every pi option is a runner; none is an *installer* that provisions the
credential, writes the workflow, exposes model/turn settings, and handles
run reporting. That gap is this extension.

### What pi gives us (verified against `@earendil-works/pi-coding-agent@1.5.0`)

- **Headless modes**: `pi -p` (final text), `--mode json` (JSONL events incl.
  `turn_start` / `turn_end` / `tool_execution_*` / `agent_settled`), `--mode
  rpc`. Print/json modes exit non-zero on `error`/`aborted`. A *turn* = one
  assistant response + its tool calls — the same unit as Claude's `--max-turns`.
- **There is no max-turns flag/setting in pi** (grepped docs and `dist`). Decided
  not to build one; see Run limits.
- **Extension hooks**: `pi.registerTool` (to expose a validated `submit_review`
  tool), `tool_call` block/terminate, `agent_before_settle`, and the turn events
  if a limit is ever wanted later.
- **Mode awareness**: `ctx.mode` is `"print" | "json" | "rpc" | "tui"`;
  `ctx.hasUI` is false headless, so one extension can serve both the
  interactive installer and the CI runner.
- **Isolation flags** for CI: `--tools read,grep,find,ls[,bash]`,
  `--no-extensions` (explicit `-e` still loads), `--no-skills`,
  `--no-prompt-templates`, `--no-themes`, `--no-session`, `-na/--no-approve`
  (project trust: repo `.pi/` extensions/settings are *not* loaded in
  print/json mode unless `defaultProjectTrust: "always"`), `--offline`.
  `AGENTS.md`/`CLAUDE.md` still load. `-e git:github.com/…` can load this
  package straight from git inside the runner.
- **Auth plumbing**: provider keys come from env (`OPENROUTER_API_KEY`,
  `OPENCODE_API_KEY`, …) or `auth.json`; `--api-key` is a non-persistent
  override; `!command` keys; `ctx.model` is the active model and
  `ctx.modelRegistry.getProviderAuth(provider)` resolves current credentials;
  `PI_PROVIDER` / `PI_MODEL` are exported to bash. `pi auth check` /
  `print-api-key` exist for scripting.
- **Security model**: pi documents no built-in sandbox; the runner/container is
  the boundary. For PR review of untrusted code that means: read-only tools or
  a throwaway runner, no long-lived secrets in the environment beyond the
  scoped review key.

### The two providers the user actually uses

- **OpenCode Go** (already implemented in `extensions/opencode-go`): Console
  OAuth **device grant** (`opencode-cli`) → session token → `provisionApiKey()`
  mints a revocable **service key `oc_sk_…`** under a `pi` service account;
  gateway `https://opencode.ai/zen/go/v1`; env var `OPENCODE_API_KEY`. We can
  reuse `requestDeviceCode`/`completeDeviceSignIn`/`provisionApiKey` directly
  with a **distinct key name** (e.g. `pi-review-<owner>-<repo>`) — important
  because `provisionApiKey` revokes any active key with the *same* name, and
  must not revoke the user's interactive dev key. Owner confirmed (from OpenCode's own docs) that CI use of a Go
  subscription is explicitly allowed and that OpenCode offers a direct pathway
  to API tokens for this purpose — **look that pathway up during milestone 3**; it
  may replace or simplify the device-grant + `provisionApiKey` route. Usage
  meters are not a concern in practice (owner: DeepSeek on Go ≈ 35% of the
  monthly allowance after ~25 days of heavy use), so no usage guard is planned.
- **OpenRouter**: two documented ways to get a key for the user, neither needs
  copying their dev key:
  1. **OAuth PKCE** — open `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256&key_label=pi-review-<repo>`,
     user approves, exchange `code` at `POST /api/v1/auth/keys` → a
     user-controlled key. Localhost callback on any port is supported; for
     SSH/containers omit `callback_url` and the page shows a code to paste
     (PKCE required). `key_label`, `workspace_id`, `required_workspace_id`
     prefill/lock the target. Docs mention no spend-limit parameter on this
     flow.
  2. **Provisioning API** (`POST /api/v1/keys` with a *management* key; `name`,
     `limit`, `limit_reset`) — gives a hard credit cap per key, but needs the
     user to already hold a management key, so offer it as an advanced path.
- Generic: anything else → paste a key (`ctx.ui.input`) or "use my current
  key" with a loud confirmation, since that exposes the dev key to CI.

### GitHub side

- **Secret**: `PUT /repos/{o}/{r}/actions/secrets/{name}` needs the repo public
  key + libsodium sealed-box encryption and a token with `repo` scope; the
  simplest path is shelling out to `gh secret set` (Claude Code also requires
  `gh`), falling back to printing the value + settings URL when `gh` is missing.
- **Identity for posting reviews** — three tiers:
  1. `GITHUB_TOKEN` (`pull-requests: write`): zero setup, posts as
     `github-actions[bot]`, cannot trigger downstream workflows. Kept only as a
     fallback when the user declines the App.
  2. **Custom GitHub App via the manifest flow**: POST a manifest to
     `github.com/settings/apps/new` (or `/organizations/ORG/settings/apps/new`),
     GitHub redirects to a localhost `redirect_url` with a one-hour `code`,
     `POST /app-manifests/{code}/conversions` returns `id`, `pem`,
     `webhook_secret`. **Default identity (owner decision).** That is how we can honestly say "install Pi as an app":
     minimal permissions (Contents: read, Pull requests: write, Issues: write,
     Checks: write optional), no webhook, an identity like `pi-review[bot]`.
     Store `APP_ID` + `APP_PRIVATE_KEY` as secrets and mint tokens in the
     workflow with `actions/create-github-app-token`. Installing the app on
     the repo is still one browser click (`/apps/<slug>/installations/new`).
  3. Hosted central App (what Claude/Kilo have) — out of scope; needs
     infrastructure.
- Fork PRs: GitHub withholds secrets, so same-repo only (same as Claude's
  review workflow). Never use `pull_request_target` + checkout of PR head.

## Design

```
extensions/pi-review/
├── index.ts        /pi-review command; switches into runner mode
├── detect.ts       git remote → owner/repo, branch, base ref, gh auth, PR lookup
├── context.ts      PR/local diff, metadata, base-branch REVIEW.md + AGENTS.md
├── diff.ts         unified-diff parsing; inline position index
├── review.ts       submission validation, summary folding, markdown rendering
├── submit.ts       submit_review tool + gh api posting
├── prompt.ts       review instructions + fenced, capped PR context
├── runner.ts       CI-only wiring (PI_REVIEW=1): tool, context, artifact
├── local.ts        headless child pi for /pi-review run
├── install.ts      /pi-review install: preflight + App/secret/installation wizard
├── github/
│   ├── app.ts      manifest code exchange, account and installation lookups
│   ├── exec.ts     stdin-capable command runner (gh secret set)
│   ├── git.ts      branch writer for the settings + workflow commit
│   ├── jwt.ts      App JWT for the installation check
│   ├── manifest.ts App manifest, registration and install URLs
│   ├── open.ts     open a URL in the system browser
│   ├── secrets.ts  repo secrets and variables via gh
│   └── server.ts   localhost redirect server for the manifest flow
├── auth/           provider credential strategies (device grant, PKCE, paste)
├── uninstall.ts    removal branch + credential deletion + App links
├── workflow.ts     render .github/workflows/pi-review.yml from settings
├── settings.ts     .github/pi-review.json schema, defaults, validation
├── panel.ts        (milestone 5) TUI panel: provider, model, thinking, triggers, tools
├── *.test.ts
├── PLAN.md
└── README.md
```

### Command surface

`/pi-review` opens the panel. Subcommands: `install` (wizard), `settings`,
`status` (is the workflow/secret/App present?), `uninstall`, `run` (local dry
run of the CI agent against the current branch/PR — this is also the main
manual-test loop while developing).

### Install wizard (mirrors `/install-github-app`, resumable, Esc-safe)

1. **Preflight**: git remote is github.com; `gh auth status`; user has admin on
   the repo (`gh api repos/:o/:r --jq .permissions.admin`). Print what will
   change before doing anything.
2. **Identity**: choose `GITHUB_TOKEN` (default) or "create a Pi GitHub App"
   (manifest flow). Re-runnable: detects an existing `PI_REVIEW_APP_ID`.
3. **Credential**: read `ctx.model.provider`. `opencode-go` → open the
   OpenCode Console device-approval page, provision a **new** `oc_sk_` key named
   `pi-review-<repo>`. `openrouter` → OAuth PKCE page with `key_label`.
   Otherwise → paste. Save as `PI_REVIEW_API_KEY`-style secret (see Open
   questions on naming) via `gh secret set`. The key never touches the repo and
   is never printed.
4. **Settings**: panel for model (list from `ctx.modelRegistry`, pre-filled with
   the current one), thinking level, trigger events, skip
   drafts/bots, tool set (read-only vs + bash for running tests), include/exclude
   path globs, cost note. Written to `.github/pi-review.json` so the workflow
   file stays generic and later edits are a settings change, not a YAML edit.
5. **Workflow**: write `.github/workflows/pi-review.yml` on a new branch, push,
   open the browser at the PR-compare URL. (Never commit to the default branch.)
6. **Summary**: list exactly what was created (secret names, key name, branch,
   App slug) and how to revoke each, like Claude's closing message.

### The workflow (generated)

```yaml
name: Pi Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
concurrency: { group: pi-review-${{ github.event.pull_request.number }}, cancel-in-progress: true }
jobs:
  review:
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npm i -g @earendil-works/pi-coding-agent@<pinned>
      - env:
          PI_REVIEW: "1"
          OPENCODE_API_KEY: ${{ secrets.PI_REVIEW_API_KEY }}   # env name chosen per provider
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: >
          pi -p --no-session --offline
          -e git:github.com/AutumnsGrove/pi-extensions@<tag>   # or the package path
          --no-skills --no-prompt-templates --no-themes -na
          --provider <p> --model <m> --thinking <level>
          --tools read,grep,find,ls,bash,submit_review
          "Review PR #$PR_NUMBER"
```

Pinned versions (pi and this package) so a model/CLI change cannot silently alter
reviews; `fetch-depth: 0` so `git diff base...head` and blame work.
`--no-extensions` plus an explicit `-e` for only this package keeps repo `.pi/`
code (attacker-controlled in a PR) from loading.

### Run limits (no turn budget)

Pi has no native max-turns control and we are deliberately not adding one: it
adds complexity for a problem the owner does not want to own. Instead rely on
what exists natively:

- `timeout-minutes` on the job (wall-clock cap) and `concurrency` with
  `cancel-in-progress` so a new push cancels a stale review.
- Cap the diff embedded in the prompt (large diffs are summarised by file list;
  the agent reads the rest on demand).
- A `GITHUB_STEP_SUMMARY` written in a `finally` (model, duration, tools
  called, exit status) so a timed-out or failed run is never silent. If the job
  fails before a review is posted, post a short "review did not complete"
  comment from an `if: failure()` step.
- Revisit a turn/cost ceiling only if real runs show a need; `turn_start` /
  `turn_end` events make it possible later.

### Posting results

Prefer the **`submit_review` tool** over letting the model run `gh`:
validates inline `path`/`line`/`side` against the actual PR diff (drop or fold
into the body when invalid, as Sim and pi-harness-action do), sanitises the body,
and posts one `POST /pulls/{n}/reviews` (event `COMMENT` by default;
`REQUEST_CHANGES` opt-in; `APPROVE` off). Keep a **sticky summary**
(hidden marker) that is updated in place on `synchronize`, and on re-push review
only `last_reviewed_sha..head`. Resolve stale threads the agent can verify are
fixed (opt-in). Read `REVIEW.md` from the **base** branch, never the PR branch.

### Security posture (defaults)

- Same-repo PRs only; no `pull_request_target`.
- Review key is a dedicated, revocable, per-repo key — never the user's dev key.
- Tool set default: `read,grep,find,ls` + `bash` behind an opt-in "let it run
  tests / probe error paths" toggle, with a warning that bash on the runner can
  read the step's env (including the review key) and a recommendation for a
  spend-capped key. A PR author can prompt-inject through the diff.
- All PR text is treated as untrusted in the prompt; the PR body/diff is
  fenced and the system prompt states it cannot change instructions.
- `.pi/` from the PR branch is never trusted; `AGENTS.md`/`CLAUDE.md` from the
  **base** branch are the repo guidance. (`AGENTS.md` auto-loads from the
  checkout, so the checkout should be of the merge-base for guidance files, or
  the review prompt must say to ignore instructions in changed guidance files.)

## Milestones

1. **Runner first** (local-testable, no GitHub setup): `runner/` + `/pi-review
   run` against the working tree, `submit_review` with a `--dry-run` that
   prints instead of posting.
2. **Custom Pi GitHub App (default identity)**: manifest flow with a localhost
   redirect, store `PI_REVIEW_APP_ID` + `PI_REVIEW_APP_PRIVATE_KEY`, one-click
   install on the repo, `actions/create-github-app-token` in the workflow.
   `GITHUB_TOKEN` remains as an opt-out fallback. ✅ Done (the workflow's token
   step lands with milestone 3).
3. **Workflow + settings**: `workflow.ts`, `settings.ts`, `gh secret set`,
   branch + PR-compare URL; manual key paste only. ✅ Done.
4. **Provider auth**: OpenCode Go (CI token pathway or `provisionApiKey`), then
   OpenRouter PKCE incl. headless code-paste. ✅ Done using the device grant +
   `provisionApiKey`; no separate CI-token API surfaced.
5. **Panel**: model/thinking/tools UI, status, uninstall. ✅ Done as a dialog
   menu (`panel.ts`) rather than a custom TUI: every common field is editable,
   with the raw JSON editor one entry away for provider/paths/pins.
6. Polish: incremental re-review, stale-thread resolution, `@pi` mention
   trigger, scheduled sweep, `REVIEW.md`. Incremental re-review and the sticky
   summary comment are done; stale threads and the `@pi` mention remain.

## Decisions (owner)

- Name: `pi-review` (command `/pi-review`). Note `earendil-works/pi-review`
  exists with `/review` and `/end-review`; no command clash, but the package
  name is similar, so keep READMEs clear about the difference (that one is
  interactive/local; this one installs and runs in CI).
- No turn budget.
- **Runner lives in this package.** The generated workflow is committed to the
  *target* repo (e.g. Polaris) and runs on that repo's runner; it fetches this
  package with `-e git:github.com/AutumnsGrove/pi-extensions@<tag>`. Nothing
  runs in the pi-extensions repo. (Repo is public, so no token is needed to
  fetch it.) Pin a tag so extension changes don't silently alter reviews.
- **Secret name:** generic `PI_REVIEW_API_KEY`, mapped to the provider env var
  in the workflow.
- **Identity:** custom Pi GitHub App from day one (`GITHUB_TOKEN` fallback).
- **Review state:** `COMMENT` by default; `REQUEST_CHANGES` is a panel opt-in;
  `APPROVE` is not offered.
- OpenCode Go in CI is permitted; usage limits are not a concern.

## Open questions

- **OpenCode's direct CI token pathway**: find it in OpenCode's docs and decide
  whether it replaces the device grant.
- **OpenRouter spend cap**: PKCE keys have no documented `limit`; a hard cap
  needs the provisioning API and a management key.
- **App ownership**: personal vs org account for the manifest flow (the
  wizard should ask; Polaris may be under a user or an org). Resolved: **one App
  per owner** (`pi-review-<owner>`), installed per repo, with the wizard's
  "use an existing App" path for additional repos.
- `auth.json`-style refreshing credentials in CI: out of scope for v1.

## Implementation notes (milestone 1)

Decisions made while building the runner, where it differs from the design above:

- **The child loads the extension file, not the package.** `-e git:github.com/…`
  loads every extension in the package, including the ones with runtime
  dependencies that have no place in a review job. `/pi-review run` and the
  workflow therefore pass `-e <path>/extensions/pi-review/index.ts`, which loads
  exactly one extension. The workflow will clone this repo at a pinned tag and
  point at that file.
- **Context is injected, not embedded in the prompt.** The workflow command line
  is just `pi -p "Review pull request #N."`; the extension loads the PR, diff,
  and guidance on `before_agent_start` and returns both a system-prompt section
  and a `pi-review-context` custom message. One code path serves CI and the
  local dry run.
- **The base commit is the only source of guidance.** The child runs with `-nc`,
  so `AGENTS.md`/`CLAUDE.md` from the merge-result checkout never load; the
  extension reads `REVIEW.md`, `.github/REVIEW.md`, `AGENTS.md`, and
  `CLAUDE.md` from the base SHA instead.
- **`PI_REVIEW_OUTPUT` is the result channel.** `submit_review` writes
  `{ dryRun, review, markdown, url }` there. `/pi-review run` reads it back; in
  CI it is the step artifact, and an `agent_settled` handler writes an
  `incomplete` marker when the agent never submitted, so the workflow can fail
  loudly.
- **Review state is still `COMMENT` by default.** `REQUEST_CHANGES` is enabled
  per run with `PI_REVIEW_REQUEST_CHANGES=1`; the settings panel will write that
  as a workflow/env setting.
- **Invalid inline comments are folded, not dropped.** They become a collapsed
  section of the summary with the reason, because a review that loses findings
  is worse than one with an unattached paragraph. Invalid `start_line` values
  are cleared while keeping the comment.

## Implementation notes (milestone 2)

- **One App per owner.** The name is `pi-review-<owner>`; adding a repository
  reuses it instead of creating another App. Personal accounts have no shared
  secrets, so the wizard accepts the App ID plus a private-key file, verifies
  the pair with an App JWT (`GET /app`), stores the secrets, and installs the
  App on that repo. Organizations can share one key through an organization
  secret. Revocation is per App (all repos) or per repo (its secrets).
- **The key is stored first, the id second.** A re-run uses
  `PI_REVIEW_APP_ID` as the "identity exists" marker, so it must never be
  written before the key it belongs to. The key goes through `gh secret set`
  on stdin (`github/exec.ts` exists because `pi.exec` cannot write stdin); it is
  never printed, logged, or written to disk. GitHub only returns the key once,
  so a storage failure names the App and points at its advanced settings to
  generate a new one.
- **`PI_REVIEW_APP_SLUG` is a repository variable, not a secret.** Secret values
  cannot be read back, and a re-run needs the slug to find the App's
  installation. The slug is not sensitive, so a variable is the right store; the
  workflow can read it as `vars.PI_REVIEW_APP_SLUG` for links.
- **Installation verification uses an App JWT, not `/user/installations`.**
  Found on the first real install: `GET /user/installations` returns 403 for a
  `gh` token ("must authenticate with an access token authorized to a GitHub
  App"). During creation the PEM is still in memory, so the wizard signs a
  nine-minute RS256 JWT (`github/jwt.ts`) and asks
  `GET /repos/{owner}/{repo}/installation`, polling briefly because a fresh
  installation can take a few seconds to appear. A reuse run has no readable
  key, so it asks the user to confirm instead; the summary says the installation
  was confirmed by them, not verified. A wrong key can only surface as a 401 at
  review time; the summary says how to rotate it.
- **The manifest flow cannot be pre-filled with a GET**, so the local server
  serves one page that auto-POSTs the manifest to GitHub. The `state` nonce is
  echoed back and required, so another local process cannot hand the wizard a
  code for an App it created. A five-minute timeout falls back to pasting the
  redirect URL (the SSH/container path); a wrong state is refused.
- **Choosing `GITHUB_TOKEN` deletes the App secrets** (after a confirmation) so
  the workflow's fallback is unambiguous rather than silently ignoring them.
- **The wizard is dependency-injected** (UI, command runner, fetch, browser,
  redirect server), so all four identity paths plus timeouts, aborts, and
  storage failures are tested without a browser or network.

## Implementation notes (milestone 3)

- **The settings file is the policy, the workflow is generated.** Every knob
  (triggers, paths, tools, verdict, model, pins, timeout) lives in
  `.github/pi-review.json`; `workflow.ts` renders deterministic YAML from it
  without a YAML dependency, because the extension runs from a bare git checkout
  in CI where this package's `node_modules` is absent. Re-running install
  regenerates the file (and commits nothing when it is unchanged).
- **Paths are one list with negations.** GitHub rejects `paths` together with
  `paths-ignore` on the same event, so excludes become `!pattern` entries; when
  only excludes are configured the list starts with `**`.
- **Package pinning defaults to the local commit.** `settings.pi.packageRef`
  defaults to this checkout's HEAD (only when its `origin` looks like
  pi-extensions); `PI_REVIEW_PACKAGE_REF` overrides it, and a tag is the right
  value once released. The workflow fetches that ref with `git fetch --depth 1`
  and runs `-e <checkout>/extensions/pi-review/index.ts`, so no other extension
  loads.
- **The review step enforces the artifact.** A run can finish with exit 0
  without submitting (the runner writes `incomplete`); the step then fails
  deliberately so the `if: failure()` step posts the "could not complete"
  comment. The job timeout is the review timeout + 5 minutes, so a timed-out
  review still reaches that step.
- **The branch writer refuses a dirty tree**, branches from the fetched default,
  commits only the two generated paths, pushes, and restores the original
  branch even when the push fails. `pi-review/setup` is reused with the first
  free `-N` suffix so a second install never force-pushes over an open PR.
- **Provider key paste is intentionally temporary.** Milestone 3 can store
  `PI_REVIEW_API_KEY` from a pasted key (or skip and set it later); milestone 4
  replaces the paste for OpenCode Go / OpenRouter with a minted, dedicated key.
  The settings' `providerEnv` decides which env var the workflow exposes it as.

## Implementation notes (milestone 4)

- **OpenCode Go reuses the existing device grant.** `auth/opencode.ts` calls
  `deviceSignIn` and `provisionApiKey` from the `opencode-go` extension with a
  per-repository key name (`pi-review-<owner>-<repo>`), so provisioning can
  never revoke the interactive `pi-<host>` key (the two names differ, and
  `provisionApiKey` only revokes active keys with the *same* name). The session
  `orgId` is forwarded. After re-reading OpenCode's docs, no separate "CI token"
  endpoint surfaced that was better than provisioning; the documented CI use is
  what this does. The module graph stays CI-safe (only `node:child_process` and
  type-only pi-ai imports).
- **OpenRouter PKCE keeps the verifier in-process.** S256 only; the auth URL
  carries `callback_url`, `state`, and `key_label` (the repo name). A one-shot
  localhost callback validates `state` and refuses a mismatched redirect; a
  five-minute timeout falls back to pasting the code from the page (the headless
  flow). Exchange is `POST /api/v1/auth/keys` and the response must contain an
  `sk-or-` key.
- **The paste path stays for everything else**, and a provider with no known env
  var gets a warning telling the user to set `providerEnv` in the settings file
  rather than silently storing a key the workflow cannot see.
- **One secret, many providers.** `PI_REVIEW_API_KEY` is mapped to the
  provider's env var by the generated workflow (`providerEnv`), so revoking is a
  single secret delete.

## Implementation notes (milestone 5, partial)

- **Settings is a dialog menu.** `/pi-review settings` walks model, thinking,
  tools, strictness, verdict, dependency install, stale threads, and the mention
  trigger as select/input dialogs, with the raw JSON editor as one entry. Each
  edit is applied to a copy; saving regenerates the workflow and commits to
  `pi-review/settings`. Turning bash off also disables dependency install so the
  pair cannot drift.
- **Uninstall is two confirmations.** The first approves the removal branch; the
  second approves deleting the credentials, with the warning that the workflow
  still on the default branch will fail until the removal PR merges. The App is
  deliberately left alone: the API can delete App private keys but not the App,
  and deleting it would also drop installations the user may still want.
- **Branch names are per action** (`pi-review/setup`, `pi-review/settings`,
  `pi-review/remove`), each with the same first-free-suffix rule, so re-running
  one never force-pushes over another's open PR.
- **The branch writer handles deletions** with `git add -A`, so uninstall is the
  same code path as install and settings.

## Implementation notes (milestone 6, part 1)

- **Incremental reviews need no extra workflow input.** Every posted review body
  ends with an invisible `<!-- pi-review:review -->` marker. The runner lists the
  PR's reviews, takes the newest marked one, checks that its commit is an
  ancestor of the new head (`git merge-base --is-ancestor`), and diffs
  `last-reviewed...head` instead of the whole PR. The prompt switches to
  follow-up mode: do not repeat findings, verify they were addressed, focus on
  the new changes. A force push (not an ancestor) falls back to a full review.
  Inline validation runs against the **full PR diff**, not the increment: the
  incremental diff is a tree comparison and can contain content outside the PR
  (a base-branch merge after the last review, or a revert of a reviewed line),
  where GitHub would reject the comment and fail the whole review. The full PR
  diff is parsed for `submit_review`; the incremental diff only shapes the
  prompt. The previous review's summary is folded into the context so
  "check whether they were addressed" is actionable.
- **The sticky comment is a status line, not a second review.** A separate
  `<!-- pi-review:summary -->` marker identifies one issue comment that is
  patched on every push with the reviewed commit, verdict, inline count, and a
  link to the review. Creating it first, updating it later.
- **Tests must never open a browser.** The real `openExternalUrl` is the default
  in the installer, and one uninstall test reached it, so every `npm test` run
  opened a GitHub compare tab. Tests now inject the opener; `openExternalUrl`
  also refuses to spawn when `VITEST` is set unless a `spawn` is injected, so a
  missed fake cannot leak a tab again.

## Implementation notes (milestone 6, part 2): verify with tests

- **Dependency install is a workflow step, not a model turn.** `verify.installDependencies`
  (only meaningful with `tools.bash`) adds an `actions/cache` restore keyed by
  the lockfile hash and an `Install dependencies` step that picks pnpm/npm/yarn
  from the lockfile, with an eight-minute timeout and `continue-on-error`. The
  step writes `PI_REVIEW_DEPS=installed|unavailable|none` to `GITHUB_ENV`; the
  runner reads it and the prompt says either "run the tests", "do not claim you
  ran them", or nothing. Installation cost and failure stay out of the agent's
  turn budget, and a failed install produces an honest note rather than an
  unverified claim.
- **The fallback prompt still exists** for repos without the step, but it is no
  longer the mechanism: the workflow does the install, the agent verifies.
- **Security is unchanged and explicit:** installing runs lifecycle scripts from
  the PR checkout, on top of the already opt-in `bash`; same-repo PRs only.

## Implementation notes (milestone 6, part 3): strictness

- The review prompt ends with a strictness section driven by
  `review.strictness` (workflow env `PI_REVIEW_STRICTNESS`). The default is
  `significant`: merge-blocking findings only, no nits and no "minor" section.
  `balanced` adds design/test gaps; `thorough` adds non-blocking suggestions.
- It is deliberately not a wizard prompt: the quiet default applies everywhere,
  and per-repo tuning is a one-line settings edit. `REVIEW.md` on the base
  branch remains the free-form channel for repo-specific rules.

## Implementation notes (milestone 6, part 4): polyglot dependency install

- The install step is ecosystem-agnostic and installs **every** detected
  manager: pnpm/npm/yarn/bun, uv/poetry/pipenv/pip/pyproject, `go mod download`,
  `cargo fetch`, `bundle install`, `composer install`, `dotnet restore`. One
  failing ecosystem does not stop the others; the step fails at the end so
  `PI_REVIEW_DEPS` stays `unavailable` and the prompt tells the reviewer not to
  claim it ran tests.
- `verify.installCommand` replaces detection for repos the heuristic cannot
  handle (monorepos with unusual layouts, private registries, a specific make
  target). It is a committed setting, reviewed like any other.
- The cache covers the package stores for all supported ecosystems and is keyed
  by their lockfiles.

## Implementation notes (milestone 6, part 5): stale-thread resolution

- Opt-in via `review.resolveStaleThreads` (workflow env
  `PI_REVIEW_RESOLVE_THREADS`). On a review, the runner reads the PR's review
  threads over GraphQL and keeps only unresolved threads whose first comment is
  from a bot. They are listed in the prompt with their ids; a
  `resolve_review_threads` tool accepts ids **only from that fetched set** and
  resolves them one by one, reporting per-id failures. Human threads and ids the
  reviewer never saw are rejected, so the model cannot resolve anything it was
  not shown.
- The prompt is explicit: resolve only what the diff verifies, and leave the
  rest. A failed mutation is reported back, not thrown.

## Implementation notes (milestone 6, part 6): `@pi` mentions

- The workflow adds `issue_comment: [created]` (on by default;
  `triggers.mention: false` removes it) and a job condition that requires a PR
  comment, `@pi` in the body, `author_association` in
  OWNER/MEMBER/COLLABORATOR, and a non-bot author. The check-out uses
  `refs/pull/<n>/merge` for both events, and the PR number expression covers
  `pull_request` and `issue_comment`.
- A same-repo guard runs before the App token on the mention path: the PR's
  `headRepository.nameWithOwner` must equal the current repository, so a
  maintainer mentioning `@pi` on a fork cannot execute fork code with secrets.
- The comment body is passed as `PI_REVIEW_REQUEST` and becomes the
  maintainer's request in the prompt (fenced, capped). It focuses the review;
  the security and output rules still apply.

## Implementation notes (milestone 7): one App per owner

- `appNameFor` returns `pi-review-<owner>` and no longer includes the repo, so
  the manifest flow creates one App per owner. For additional repositories the
  wizard offers **Use an existing Pi GitHub App**: it reads the App ID and a
  `.pem` from disk, signs a JWT, and calls `GET /app` — which both fetches the
  slug/name and proves the credentials. The key is written to the repo secret on
  stdin, never printed, and the installation is verified with the same JWT.
- The "reuse the App on this repository" path stays for repos that already have
  the secrets. Its summary is explicit that the installation is user-confirmed,
  because the stored key cannot be read back; the new path *can* verify.
