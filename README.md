# pi-extensions

A growing collection of [pi](https://github.com/earendil-works/pi) extensions,
packaged as a single installable [pi package](https://github.com/earendil-works/pi/blob/main/docs/packages.md).

## Extensions

| Extension | What it does | Status |
| --- | --- | --- |
| [`provider-pinning`](extensions/provider-pinning/) | Pin OpenRouter requests to a chosen upstream provider so prompt caching stays warm, with a full provider comparison table (`/provider`). | working |
| [`parallel`](extensions/parallel/) | Parallel-backed `web_search` + `web_fetch` tools with a local monthly quota hard cap and model-summarized page reading (`/parallel-login`). | working |
| [`extension-divider`](extensions/extension-divider/) | A light grey `///` between each item on the extension status line (`/divider`). | working |
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
│   └── extension-divider/
│       ├── index.ts
│       ├── divider.ts
│       ├── PLAN.md
│       └── README.md
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

## Development cost
*Note: The model used to develop is always deepseek/deepseek4.1 provided by Deepseek themselves (pinned via the provider-pinning extension)*

| Extension | Cost |
| --- | --- |
| provider-pinning | $0.417 |
| parallel | $0.303 |
| extension-divider | $0.100 |

## License

MIT. See [LICENSE](LICENSE).
