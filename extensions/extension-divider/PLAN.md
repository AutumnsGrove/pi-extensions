# Plan: extension-divider

## Why

Several extensions add badges to pi's single status line via
`ctx.ui.setStatus()`. Pi joins them with one space and offers no separator, so
with two or three badges the line reads as one run-on string. A faint `///`
between items makes each badge scannable, and doing it centrally means every
future status extension gets dividers for free.

## What pi gives us

- `ctx.ui.setStatus(key, text)` — the only status API. Values are sorted by key
  and joined with `" "` inside pi's built-in `FooterComponent`.
- `ctx.ui.setFooter(factory)` — replaces the whole footer. The factory receives
  `(tui, theme, footerData)`; `footerData.getExtensionStatuses()` is the only
  way an extension can read the other statuses.
- `FooterComponent` is a public export of `@earendil-works/pi-coding-agent`, so
  the non-status footer lines can be reused instead of reimplemented.

There is no separator option, no status-change event, and no way to read
statuses outside a custom footer.

## Decision

Own the footer while enabled:

1. On `session_start` (TUI mode only) call `ctx.ui.setFooter()`.
2. Inside the factory, build a `FooterComponent` backed by a proxy "session"
   that forwards to `ctx` via getters (`sessionManager`, `model`, `state`,
   `getContextUsage`) and stubs the two fields with no public equivalent
   (`routedModel`, `modelRuntime.isUsingSubscription`).
3. In `render`, replace the last line — pi always appends the status line last
   when statuses exist — with the statuses joined by a dim `///`.

`/divider` toggles it and restores the built-in footer. `session_shutdown`
removes it.

## Rejected

- **Shared helper imported by every status extension.** Not automatic; every
  new extension would have to remember to use it.
- **Setting a divider status key per gap.** Keys and item count are unknown
  ahead of time and change at runtime.
- **Reimplementing the footer from scratch.** Duplicates pwd, token totals,
  context percentage, model and provider logic that will drift from pi.

## Risks

- Uses `FooterComponent` with a duck-typed session; pi could change the fields
  it reads. Version-locked by the peer dependency and covered by a smoke test.
- Only one custom footer exists at a time; a competing footer extension wins.
- The `(auto)` compaction indicator assumes pi's default (`true`) because the
  live AgentSession flag is not exposed to extensions.
