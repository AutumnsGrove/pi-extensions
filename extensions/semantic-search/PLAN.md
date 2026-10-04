# semantic-search — build plan

Native, local semantic code search for pi. A TypeScript port of the ~20% of
[`ory/lumen`](https://github.com/ory/lumen) that produces the value: symbol-level
chunking, incremental Merkle indexing, and a `semantic_search` tool the model
actually reaches for.

Status: **phases 1–4 done** — chunker layer, embed/store/split, ignore + Merkle
+ indexer, and search/format + pi wiring, with configurable Ollama models
(`/semsearch model`). 150 extension tests, verified end to end against local
Ollama. Phases 5–6 pending (eval harness, polish).

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Form factor | Native pi extension (tools + events + commands), **not** an MCP bridge |
| Languages, day one | Go, TS/TSX, JS/JSX, Python, Svelte, JSON, YAML, Shell |
| Incrementality | Merkle diff + changed-file-only embedding from day one |
| Embeddings | Ollama only; model selectable via env, config file, or `/semsearch model` |
| Vector store | `node:sqlite` (built-in) + `sqlite-vec` npm (0.1.9, same version lumen vendors) |
| Chunking | `@vscode/tree-sitter-wasm` (matched runtime + grammars) |
| Process model | Test-first (TDD); mirror lumen's Go tests where they apply |
| Cost | Every work session tracked by `extensions/cost-tracker` |

## Non-goals (deferred, not never)

- Git-worktree shared collections and content-addressed vector dedup.
- The full 12-language matrix (Rust, Ruby, Java, PHP, C/C++, C#, Swift, Dart).
- Int8 vector quantization and float32 fallback profiles.
- `mattn/go-sqlite3`-class cross-process locking (use `proper-lockfile` only if
  concurrent indexers actually happen).
- Markdown chunking (lumen has it; low value for our work, easy to add later).

## Why native beats the MCP bridge

Lumen gets its results from *three* surfaces, and pi only fires one of them for
an MCP server:

1. `semantic_search` tool (MCP — ported easily).
2. SessionStart hook injecting "index ready, use semantic search first"
   (Claude-specific — **does not fire in pi**).
3. PreToolUse hook intercepting `Grep|Glob|Bash(rg/grep/find)` (Claude-specific —
   **does not fire in pi**).

A native extension replaces (2) with `before_agent_start` /
`promptGuidelines`, and (3) with `pi.on("tool_call")` — and can go further by
actually running a semantic search when the model reaches for `grep`/`find`.

## Architecture

```
extensions/semantic-search/
  index.ts                     # pi wiring: registerTool, events, commands
  src/
    config.ts                  # model registry, env, paths, profile key
    util.ts                    # sha256, batching, line helpers
    chunk/
      types.ts                 # Chunk, Chunker
      go.ts                    # tree-sitter-go queries
      ts.ts                    # ts / tsx / js / jsx
      python.ts
      bash.ts                  # net-new (lumen has no shell support)
      svelte.ts                # <script> extraction -> ts.ts, line-offset
      structured.ts            # json / yaml key-path chunker
      index.ts                 # extension -> chunker dispatch (MultiChunker)
    embed/
      registry.ts              # KnownModels, dims, context, min-score floor
      ollama.ts                # POST /api/embed, batched
    store/
      schema.ts                # tables + vec0 virtual table
      sqlite.ts                # open, upsert, delete, meta, stats
      search.ts                # KNN + path prefix
    index/
      ignore.ts                # 6-layer filter (.gitignore, .pi-searchignore, linguist)
      merkle.ts                # SHA-256 tree + diff
      indexer.ts               # EnsureFresh / Index / Status
      split.ts                 # oversized chunk splitting at boundaries
    search/
      rank.ts                  # kind boost, test demotion, overlap merge
      format.ts                # XML-tagged result rendering
  fixtures/<lang>/             # expected-chunk fixtures (authored first)
  test/*.test.ts
bench/                         # eval harness (phase 5)
```

### Core types

```ts
interface Chunk {
  id: string;        // sha256(filePath + symbol + startLine)[:16]
  filePath: string;  // relative to project root
  symbol: string;
  kind: "function" | "method" | "type" | "interface" | "const" | "var" | "package";
  startLine: number; // 1-based
  endLine: number;
  content: string;
}
```

### Pipeline

```
walk → 6-layer filter → merkle diff → changed files only
     → chunk (tree-sitter / structured) → split oversized
     → batch embed (32-request batches, async) → SQLite + vec0
     → KNN (cosine) → kind boost / test demotion → merge overlaps
     → XML snippets back to the model
```

### Storage

Same identity philosophy as lumen, simplified:

```
~/.local/share/pi-semantic-search/<hash>/index.db
hash = sha256(git common dir | model | dims | maxChunkTokens | INDEX_VERSION)[:16]
```

`INDEX_VERSION` is a hardcoded constant, bumped whenever chunker/embedder/schema
changes make old indexes incompatible. Bump **without** re-using the git hash.

## Dependencies

| Package | Use | Notes |
| --- | --- | --- |
| `@vscode/tree-sitter-wasm` | chunking | ships a runtime and grammars built against one ABI; no native build |
| `sqlite-vec` | vector KNN | prebuilt binary; `db.loadExtension(getLoadablePath())` |
| `node:sqlite` | storage | built-in; construct with `{ allowExtension: true }` |
| `ignore` | gitignore semantics | already a pi dependency |
| `yaml` | JSON/YAML structured chunks | already a pi dependency |
| `typebox` | tool schema | provided by pi |
| `proper-lockfile` (optional) | index lock | only if needed |

**Why `@vscode/tree-sitter-wasm` and not `web-tree-sitter` + `tree-sitter-wasms`:**
the popular `tree-sitter-wasms` bundle is built for an old tree-sitter ABI and
fails to load with current `web-tree-sitter` runtimes (verified: `getDylinkMetadata`
throw). The VS Code package ships a runtime and grammar set built together, so
versions cannot drift.

**`node:sqlite` and `sqlite-vec` are loaded through `createRequire`:** Vite 5
(the vitest bundler) does not know the newer `node:sqlite` builtin and fails to
resolve it, and `sqlite-vec` is CommonJS. Loading both through `createRequire`
keeps them working under Node, vitest, and pi's jiti loader, with full typing
kept via `import type`.

**Vector precision:** the store uses float32 vectors; the `vectorStorage`
profile key exists but int8 quantization is deferred (see #Non-goals).

**Grammar coverage:** go, typescript, tsx, javascript, python, bash. It does
**not** ship svelte; we extract `<script>` blocks and re-parse with the TS
chunker (mirrors lumen's two-phase approach without the outer grammar). JSON and
YAML use the structured chunker.

## Pi integration surface

| pi API | Purpose |
| --- | --- |
| `registerTool("semantic_search", …)` | the search tool; `promptGuidelines` push "search before grep/read" |
| `registerTool("index_status", …)` | status/debug tool |
| `on("session_start")` | start background indexing; set `ctx.ui.setStatus("semsearch", …)` |
| `on("before_agent_start")` | inject compact index-readiness note when useful |
| `on("tool_call")` | intercept `grep`/`find`/`bash`; either suggest or auto-answer |
| `registerCommand("semsearch")` | `status`, `reindex`, `model [name] [dims]` |
| config file | `~/.pi/agent/semantic-search.json` selects the embedding model |

Exposure: `semantic_search` is `direct`; `index_status` may be `deferred`.

## Test-first plan (mirrors lumen)

Every test is written before the implementation. Lumen test names are shown to
the right where a direct analogue exists.

### 1. `test/chunk.go.test.ts`

Mirror `internal/chunker/goast_test.go`:
`ChunkFunctions` · `ChunkMethods` · `ChunkTypes` · `ChunkInterfaces` ·
`ChunkConstsAndVars` · `ChunkIncludesDocComment` · `ChunkIDsDeterministic` ·
`NoPackageChunk`.

Implementation note: lumen uses Go's native AST. We use `tree-sitter-go`; tests
assert symbol/kind/line-range, not parser internals.

### 2. `test/chunk.ts.test.ts`

Mirror `treesitter_test.go` (`TestTreeSitterChunker_TypeScript`,
`_TypeScript_ModernPatterns`, `_TypeScript_ExportedConsts`, `_TSX`,
`_JavaScript`, `_JavaScript_ModernPatterns`) and `treesitter_adversarial_test.go`
(`_Python`, `_TypeScript`, `_TSX`, `_JavaScript`, `_NoFalsePositivesFromComments`,
`_ChunkInvariants`, `_TypeScript_Namespace`, `_JavaScript_LetFunction`).

### 3. `test/chunk.python.test.ts`

Mirror `_Python`, `_Python_Comprehensive`, `_Adversarial_Python`: functions,
classes, decorated definitions, module-level assignments, no comment false
positives.

### 4. `test/chunk.svelte.test.ts`

Mirror `svelte_test.go`: `TestSvelteChunker_ScriptSymbols`,
`TestSvelteChunker_NoSymbolsCases`. Extra assertions: line numbers are
file-relative; `<script module>` and instance scripts both handled; template
expressions ignored.

### 5. `test/chunk.bash.test.ts` (net-new; no lumen analogue)

Function definitions (`name() {`, `function name {`), top-level commands as
`package`/`var` kinds, variable assignments, shebang handling, heredocs not
mis-chunked, comments ignored.

### 6. `test/chunk.structured.test.ts`

Mirror `structured_test.go`: `SmallYAML_SingleChunk`,
`LargeYAML_SplitsAtTopLevelKeys`, `JSON_SmallFile`,
`JSON_LargeFile_SplitsAtKeys`, `Empty`, `MultiDocYAML`,
`PathPrefix_ContentEmbedded`.

### 7. `test/chunk.dispatch.test.ts`

Mirror `multi.go` tests: `TestMultiChunker_Dispatch`,
`TestDefaultLanguages_AllExtensionsPresent`, `TestTreeSitterChunker_NoDuplicateChunks`,
`TestAdversarial_ChunkInvariants` (start ≤ end, non-empty content, stable ids,
no duplicate ids).

### 8. `test/ignore.test.ts`

Mirror `internal/merkle/ignore_test.go`: `MakeSkip_GitignorePatterns`,
`NoGitignore`, `NegationPattern`, `HardcodedFiles`, `HardcodedDirs`,
`NestedGitignore`, `LumenIgnore` → `.pi-searchignore`, `NestedLumenIgnore`,
`GitattributesGenerated`, `GitattributesNestedDir`, `GitattributesNonGenerated`,
`AllLayersCombined`, `ParseLinguistExcluded`, `MakeSkipWithExtra_SkipsWorktreePaths`,
`IsRootUnindexable`.

### 9. `test/merkle.test.ts`

Mirror `merkle_test.go`: `BuildTree_WithGitignore`, `WithNestedGitignore`,
`EmptyDir`, `SingleFile`, `SkipsGitAndVendor`, `ParallelMatchesSerial`,
`CollectFilePaths_SkipsSymlinks`, `_SkipsLargeFiles`, `_SkipsPermissionDeniedFile`,
`Diff_NoChanges`, `_DetectsModifiedFile`, `_DetectsAddedAndRemovedFiles`.

### 10. `test/embed.ollama.test.ts`

Mirror `ollama_test.go` with a mocked `fetch`:
`Embed`, `Batching`, `Dimensions`, `ModelName`, `ErrorHandling`,
`ContextCancelledStopsRetry`, `NumCtx`.
Failover subset mirroring `failover_test.go`: `FirstHealthy`, `OnEmbedError`,
`4xxNoFailover`, `AllExhausted`, `DimensionsReflectActive`, `CancellationStopsFallbackHealthProbe`.

### 11. `test/store.test.ts`

Mirror `store_test.go`: `CreatesSchema`, `SetGetMeta`, `UpsertAndSearchVectors`,
`DeleteFileChunks`, `GetFileHashes`, `Stats`, `Pragmas`, `ChunkIndexesExist`,
`DimensionMismatchRecreatesTable`, `SearchWithPathPrefix`,
`SearchPathPrefixNoFalsePositives`, missing shared-vector handling.

### 12. `test/split.test.ts`

Mirror `split_test.go`: `UnderLimit`, `SplitsLargeChunk`, `SingleHugeLine`,
`ZeroMaxTokens`, `MixedSizes`; `PartitionLines_*` at blank line / closing brace /
comma / `end` / dedent / lookback edge / fallback.

### 13. `test/indexer.test.ts`

Mirror `index_test.go`: `IndexAndSearch`, `IncrementalIndex`,
`DetectsModifiedFiles`, `ForceReindex`, `Status`, `EnsureFresh`, `IsFresh`,
`LastIndexedAt_*`, `ProgressFunc`, `SkipsBinaryFiles`, `SkipsUnchunkableFile`,
`SkipsPermissionDeniedFile`, `StaleUnsupportedExtension*`,
`SupportedFileRemovedFromDisk`, `MixedStaleAndValidRemovals`,
`StoresProjectPathMeta`, `SkipsNestedGitReposInNonGitParent`.

### 14. `test/rank.test.ts` / `test/format.test.ts`

No direct lumen test file (logic lives in `cmd/stdio.go`): source-kind boost,
test-file demotion, overlap/adjacency merge, limit cap, `min_score` filtering
and filtered hint, `summary` mode, `max_lines` truncation, XML grouping and
escaping, empty-result message, stale/reindex warnings.

### 15. `test/config.test.ts`

Mirror `config_test.go`: defaults, env overrides, profile-key composition
(model, dims, storage, maxChunkTokens, `INDEX_VERSION`), model alias
canonicalization, dims fallback / explicit / unresolvable, unknown model
requires `*_EMBED_DIMS`.

### 16. `test/pi.test.ts`

Integration of the wiring only (no network): tools registered with expected
names and `promptGuidelines`; `session_start` schedules indexing;
`tool_call` for `grep`/`find`/`bash` returns the interception result;
commands parse `status|reindex|doctor`.

## Eval harness (phase 5)

`bench/` runs real bug-fix tasks through pi with and without the extension and
captures the numbers.

```
bench/
  tasks/<slug>/{repo.tar.gz|clone.json, issue.md, verify.sh}
  run.ts        # pi --mode json, capture JSONL, apply patch, run verify
  compare.ts    # with/without table: cost, time, tokens, pass/fail
```

`pi --mode json` emits per-message `usage` (input/output/cacheRead/cacheWrite/
cost/totalTokens), so cost is exact, not estimated. Start with one task per
day-one language family: Go, TypeScript, JavaScript, Python, Svelte.

**Definition of done for the project:** the compare table shows a token or cost
reduction with patch quality maintained on at least 3 of 5 tasks. If it does
not, we stop.

## Phases

| Phase | Content | Gate |
| --- | --- | --- |
| 0 | `extensions/cost-tracker` (done first) | ✅ `/cost start` → `/cost stop` writes a row |
| 1 | scaffold, chunkers (Go/TS/JS/Python/Svelte/JSON/YAML/bash) | ✅ 48 chunker tests green |
| 2 | `embed` + `store` + `split` | ✅ 38 offline tests green; real-Ollama smoke pass |
| 3 | `ignore` + `merkle` + `indexer` | ✅ 34 tests green; real-Ollama incremental pass |
| 4 | `search` + `format` + pi wiring (tools/events/commands) | ✅ 25 tests green; real-Ollama tool-pipeline smoke |
| 5 | eval harness + first measured number | ≥3/5 tasks improve |
| 6 | polish: model switching UX, docs | — |

## Risks

- **Does retrieval even help in pi?** pi already auto-compacts, so the delta may
  be smaller than in Claude Code. The eval harness (phase 5) is the honest test;
  run it before over-investing.
- **`node:sqlite` maturity.** Works on Node 26 (`allowExtension: true` verified);
  fall back to `better-sqlite3` or `usearch` if it is unstable.
- **tree-sitter WASM chunk parity.** Query syntax is the same, but grammar
  versions differ from lumen's C grammars; fixtures guard regressions.
- **First-index latency in JS.** Ollama does the heavy lifting; batch async
  `fetch` should be adequate, but large monorepos may be slower than Go. Measure.
- **Svelte template coverage.** Script-only chunking misses markup; acceptable
  until proven otherwise.

## Open questions

- Should `tool_call` interception **auto-run** a search for `grep`/`find`, or
  only nudge? (Auto-run is a stronger pi-native differentiator, but can surprise.)
- Chunk size / `maxChunkTokens` default: mirror lumen's 512 or tune for jina?
- Windows support now or later? (`node:sqlite` and WASM are cross-platform;
  path handling is the only work.)
