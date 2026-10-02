# provider-pinning

Pin OpenRouter requests to one upstream provider so prompt caching stays warm.

OpenRouter load-balances a model across many endpoints (DeepSeek's own API,
Morph, Fireworks, Together, …), each with its own KV cache. When routing hops
between them, every request is a cold cache. This extension lets you pick the
endpoint you want and holds every request there.

## Usage

| Command | What it does |
| --- | --- |
| `/provider` | Open the provider table for the current model. |
| `/provider <tag>` | Pin directly to a provider slug (e.g. `/provider deepseek`). |
| `/provider off` | Clear the pin for the current model. |
| `/pin` | Alias of `/provider`. |
| `/pins` | List every pin. |
| `Ctrl+Shift+K` | Open the provider table for the current model. |

Selecting a model with the built-in `/models` picker shows a one-line nudge when
that model has no pin. The built-in selector does not expose a hook to add a
button, so this is the closest bridge.

### Table keys

| Key | Action |
| --- | --- |
| `↑` / `↓` (or `j` / `k`) | Move |
| `Enter` | Pin the highlighted endpoint (or clear on the "Default routing" row) |
| `f` | Toggle strict (`only`, no fallbacks) ⇄ allow fallbacks |
| `s` | Cycle sort: recommended (cache) → price → speed → latency → uptime |
| `/` | Filter by provider, tag, or quantization |
| `d` | Clear the pin |
| `Esc` | Cancel |

`●` marks the pinned endpoint, `✓` marks the provider OpenRouter actually
served last. The recommended sort puts endpoints that support implicit caching
first, then sorts by cache-read price.

## How it works

The extension registers a `before_provider_request` handler that rewrites the
OpenRouter request body:

```json
{
  "provider": {
    "only": ["deepseek"],
    "allow_fallbacks": false
  }
}
```

`only` is a hard allowlist, so another extension's `provider.sort` cannot undo a
pin. Locally owned fields such as `zdr` are preserved. Pins are global per
model, stored in `provider-pins.json` in the pi agent directory, and survive
across sessions.

The provider list comes from

```
GET {baseUrl}/models/{model}/endpoints
```

with the OpenRouter API key attached, which is what makes latency and
throughput percentiles populate. Results are cached in memory and in
`provider-endpoints-cache.json` so the table opens instantly and works offline.

The base URL honours `ORI_OPENROUTER_BASE_URL` / `ORI_OPENROUTER_REGION`, so it
works under [Ori](https://github.com/AutumnsGrove) too.

## Permissions and data

- Reads `OPENROUTER_API_KEY` from the environment (or Ori's variables).
- Makes one HTTPS request to the OpenRouter endpoints route per model, on
  demand, with the key as a bearer token.
- Writes only `provider-pins.json` and `provider-endpoints-cache.json` in the
  agent directory.

## Development

```bash
pnpm install
pnpm check   # tsc --noEmit
pnpm test    # vitest
```

Built with about **$0.357** of OpenRouter credits.
