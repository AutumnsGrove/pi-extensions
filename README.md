# pi-extensions

A growing collection of [pi](https://github.com/earendil-works/pi) extensions,
packaged as a single installable [pi package](https://github.com/earendil-works/pi/blob/main/docs/packages.md).

## Extensions

| Extension | What it does | Status |
| --- | --- | --- |
| [`provider-pinning`](extensions/provider-pinning/) | Pin OpenRouter requests to a chosen upstream provider so prompt caching stays warm, with a full provider comparison table (`/provider`). | working |
| [`parallel`](extensions/parallel/) | Parallel-backed `web_search` + `web_fetch` tools with a local monthly quota hard cap and model-summarized page reading (`/parallel-login`). | working |
| [`extension-divider`](extensions/extension-divider/) | A light grey `///` between each item on the extension status line (`/divider`). | working |
| [`thinking-box`](extensions/thinking-box/) | Collapsible, timed thinking traces: stream into a short box showing duration + reasoning tokens, expand the full trace with `Ctrl+O` (`/thinking-box`). | working |
| [`pi-q-n-a`](extensions/pi-q-n-a/) | Model-facing `pi-q-n-a` tool: a multi-question form with single/multi-select, an always-present "Type something", per-question notes, optional side-by-side previews, and partial submit. | working |
| [`cost-tracker`](extensions/cost-tracker/) | Tracks development cost from pi's own session usage. `/cost start` … `/cost stop` in pi, or `pnpm cost` from a shell; finalizes runs and auto-imports the table below. | working |
| [`semantic-search`](extensions/semantic-search/) | Native local semantic code search: tree-sitter chunking, Merkle-incremental indexing, Ollama embeddings, SQLite + sqlite-vec retrieval. | in progress (pipeline) |
| _more to come_ | | |

## Install

Git package (pinned to a ref is recommended once tagged):

```bash
pi install git:github.com/AutumnsGrove/pi-extensions
```

Try it for one invocation without saving:

```bash
pi -e git:github.com/AutumnsGrove/pi-extensions
```

Local development checkout:

```bash
pi -e /path/to/pi-extensions
```

Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, and `typebox` at runtime; they are declared as peer
dependencies and never bundled.

## Layout

```
pi-extensions/
├── extensions/
│   ├── provider-pinning/     # one directory per extension, each with index.ts
│   │   ├── index.ts
│   │   └── PLAN.md
│   ├── parallel/
│   │   ├── index.ts
│   │   ├── PLAN.md
│   │   └── README.md
│   ├── extension-divider/
│   │   ├── index.ts
│   │   ├── divider.ts
│   │   ├── PLAN.md
│   │   └── README.md
│   ├── thinking-box/
│   │   ├── index.ts
│   │   ├── patch.ts
│   │   ├── patch.test.ts
│   │   ├── stats.ts
│   │   ├── stats.test.ts
│   │   ├── PLAN.md
│   │   └── README.md
│   ├── pi-q-n-a/
│   │   ├── index.ts
│   │   ├── index.test.ts
│   │   ├── schema.ts
│   │   ├── questionnaire.ts
│   │   ├── questionnaire.test.ts
│   │   ├── component.test.ts
│   │   ├── layout.ts
│   │   ├── layout.test.ts
│   │   ├── PLAN.md
│   │   └── README.md
│   ├── cost-tracker/
│   │   ├── index.ts
│   │   ├── ledger.ts
│   │   ├── cli.ts
│   │   ├── ledger.test.ts
│   │   ├── index.test.ts
│   │   └── PLAN.md
│   └── semantic-search/
│       └── PLAN.md           # in progress
├── package.json              # pi manifest: extensions/*/index.ts
└── tsconfig.json
```

Add a new extension by creating `extensions/<name>/index.ts` that default-exports
a factory taking `ExtensionAPI`. See pi's
[extensions docs](https://github.com/earendil-works/pi/blob/main/docs/extensions.md).

## Development

```bash
pnpm install        # dev-only (typescript, vitest)
pnpm check          # tsc --noEmit
pnpm test           # vitest run
```

Extensions are loaded directly as TypeScript by pi (via jiti); there is no build
step.

### Tracking development cost

`cost-tracker` reads pi's own session usage, so every run is measured exactly.
Start a run before working on an extension and stop it when done:

```bash
pnpm cost start semantic-search   # or /cost start semantic-search inside pi
pnpm cost stop                    # finalize + refresh the table below
pnpm cost report                  # print the ledger without changing anything
```

`/cost stop` (or `pnpm cost stop`) rewrites the block between the
`COST:START`/`COST:END` markers below.

## Development cost
*Note: The model used to develop is always deepseek/deepseek4.1 provided by Deepseek themselves (pinned via the provider-pinning extension)*

<!-- COST:START -->
| Extension | Cost | Tokens | Runs |
| --- | --- | --- | --- |
| provider-pinning | $0.417 | 0 | 1 |
| parallel | $0.303 | 0 | 1 |
| pi-q-n-a | $0.228 | 0 | 1 |
| thinking-box | $0.113 | 0 | 1 |
| extension-divider | $0.100 | 0 | 1 |
| cost-tracker | $0.082 | 0 | 1 |
| **Total** | **$1.243** | **0** | **6** |
<!-- COST:END -->

## License

MIT. See [LICENSE](LICENSE).
