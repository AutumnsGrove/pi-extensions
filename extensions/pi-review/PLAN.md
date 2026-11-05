# pi-review — one-command agentic PR review for pi

Goal: run one command inside pi (`/pi-review install`) and have the current
repository reviewed by a **pi agent running in GitHub Actions** on every pull
request — the same experience as Claude Code's `/install-github-app`, but with
whatever provider pi is logged into (OpenCode Go, OpenRouter, …), with the
model configurable from a panel.

Status: **plan only — nothing implemented.** Researched 2026-11-05; scope updated after owner review (name `pi-review`, no turn budget, OpenCode Go in CI is explicitly permitted). Tracked in
the GitHub issue "Add `pi-review` extension".

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
├── index.ts        /pi-review command; registers mode-specific behaviour
├── detect.ts       git remote → owner/repo, gh auth, current provider/model
├── auth/
│   ├── index.ts    strategy interface: detect(ctx) → "opencode-go" | "openrouter" | "manual"
│   ├── opencode-go.ts   reuse opencode-go/oauth.ts with key name pi-review-<owner>-<repo>
│   ├── openrouter.ts    PKCE + localhost callback / headless code paste
│   └── manual.ts        paste key / use current key (with warning)
├── github/
│   ├── secrets.ts  gh secret set (+ fallback instructions)
│   ├── app.ts      manifest flow, localhost redirect server, pem → secrets
│   └── pr.ts       open "create PR" URL for the workflow branch
├── workflow.ts     render .github/workflows/pi-review.yml from settings
├── settings.ts     .github/pi-review.json (committed) schema + defaults
├── panel.ts        TUI panel: provider, model, thinking, triggers, tools
├── runner/
│   ├── index.ts    CI-only: activated by PI_REVIEW=1, ctx.mode print/json
│   ├── submit.ts   submit_review tool: validate inline positions, post one review
│   └── prompt.ts   review prompt, PR context, REVIEW.md (base branch)
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
   `GITHUB_TOKEN` remains as an opt-out fallback.
3. **Workflow + settings**: `workflow.ts`, `settings.ts`, `gh secret set`,
   branch + PR-compare URL; manual key paste only.
4. **Provider auth**: OpenCode Go (CI token pathway or `provisionApiKey`), then
   OpenRouter PKCE incl. headless code-paste.
5. **Panel**: model/thinking/tools UI, status, uninstall.
6. Polish: incremental re-review, stale-thread resolution, `@pi` mention
   trigger, scheduled sweep, `REVIEW.md`.

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
  wizard should ask; Polaris may be under a user or an org). Should one App be
  reused across all of the owner's repos? (Likely yes: one App, installed per repo.)
- `auth.json`-style refreshing credentials in CI: out of scope for v1.
